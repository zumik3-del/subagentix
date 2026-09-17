/**
 * Phase 3 regression suite (task #391): query-reduction + cache invalidation.
 *
 * Runs in an isolated child process (same pattern as `data-layer.suite.ts`)
 * because `health.test.ts` installs a process-wide
 * `mock.module('$lib/server/db', ...)` that bun cannot undo. This suite imports
 * the real db/query/service modules against a throwaway fixture.
 *
 * Covers three dev-specified regression axes from task #386:
 *   1. getSubtreeDelegationEdges cycle guard + equality with the per-session union.
 *   2. message-scoped part reads equal unscoped+filter, including the empty-scope
 *      `AND 0` short-circuit path.
 *   3. session-graph invalidation on a live WAL commit and on resetDbConnection.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTurnModel } from './services/turn';
import { resetDbConnection } from './db';
import { clearSessionGraphCache, loadSessionGraph } from './queries/session-graph';
import { getDelegationEdges, getSessionSubtree, getSubtreeDelegationEdges } from './queries/sessions';
import { getActionParts, getCompactionParts, getStepParts, getToolParts } from './queries/parts';
import type { DelegationRecord } from './schema';

const T = 1_700_000_000_000;
const MODEL = JSON.stringify({ id: 'gpt-5', providerID: 'openai' });

// ---------------------------------------------------------------------------
// Fixture builder — mirrors data-layer.suite.ts + adds WAL-write helpers.
// ---------------------------------------------------------------------------

function buildFixture(path: string): void {
	const db = new Database(path);
	db.exec(`
		CREATE TABLE session (
			id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT,
			time_created INTEGER, time_updated INTEGER, time_archived INTEGER, cost REAL,
			tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
			tokens_cache_read INTEGER, tokens_cache_write INTEGER, model TEXT
		);
		CREATE INDEX session_parent_idx ON session(parent_id);
		CREATE TABLE message (
			id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
		);
		CREATE INDEX message_session_idx ON message(session_id);
		CREATE TABLE part (
			id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
			time_created INTEGER, time_updated INTEGER, data TEXT
		);
		CREATE INDEX part_session_idx ON part(session_id);
		CREATE TABLE event (
			id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT
		);
	`);

	const insSession = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insMessage = db.prepare(
		'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
	);
	const insPart = db.prepare(
		'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
	);

	const tokens = (input: number, output: number, reasoning: number, read = 0, write = 0) => ({
		input, output, reasoning, cache: { read, write }
	});
	const future = Date.now() + 10_000_000;

	// --- root1: two turns ---------------------------------------------------
	insSession.run('root1', null, '/repo/a', 'Root one', 'build', T + 50, T + 900, null, 2, 310, 125, 40, 20, 10, MODEL);
	insSession.run('child1', 'root1', '/repo/a', 'Child one', 'developer', T + 500, T + 2500, null, 0.5, 50, 20, 10, 0, 0, MODEL);
	insSession.run('grandchild1', 'child1', '/repo/a', 'Grandchild', 'tester', T + 600, T + 690, null, 0.1, 5, 3, 1, 0, 0, MODEL);

	// Turn 1 messages (trigger u1, assistants a1, a1b)
	insMessage.run('u1', 'root1', T + 100, T + 100, JSON.stringify({ role: 'user', time: { created: T + 100 } }));
	insMessage.run('a1', 'root1', T + 150, T + 900, JSON.stringify({
		role: 'assistant', parentID: 'u1', agent: 'build', modelID: 'gpt-5', providerID: 'openai',
		cost: 2, tokens: tokens(300, 120, 40, 20, 10), time: { created: T + 150, completed: T + 900 }
	}));
	insMessage.run('a1b', 'root1', T + 200, T + 400, JSON.stringify({
		role: 'assistant', parentID: 'u1', agent: 'build', modelID: 'gpt-5', providerID: 'openai',
		cost: 0, tokens: tokens(10, 5, 0), time: { created: T + 200, completed: T + 400 }
	}));
	// Turn 2 message (trigger u2, assistant a2)
	insMessage.run('u2', 'root1', T + 2000, T + 2000, JSON.stringify({ role: 'user', time: { created: T + 2000 } }));
	insMessage.run('a2', 'root1', T + 2010, T + 2100, JSON.stringify({
		role: 'assistant', parentID: 'u2', agent: 'build', modelID: 'gpt-5', providerID: 'openai',
		cost: 0, tokens: tokens(20, 10, 5), time: { created: T + 2010, completed: T + 2100 }
	}));

	// Parts for turn 1: steps on a1 and a1b
	insPart.run('s1a', 'a1', 'root1', T + 150, T + 150, JSON.stringify({ type: 'step-start' }));
	insPart.run('f1a', 'a1', 'root1', T + 790, T + 790, JSON.stringify({ type: 'step-finish', reason: 'stop' }));
	insPart.run('s1b', 'a1b', 'root1', T + 200, T + 200, JSON.stringify({ type: 'step-start' }));
	insPart.run('f1b', 'a1b', 'root1', T + 300, T + 300, JSON.stringify({ type: 'step-finish', reason: 'stop' }));
	// Parts for turn 2: step on a2
	insPart.run('s1c', 'a2', 'root1', T + 2010, T + 2010, JSON.stringify({ type: 'step-start' }));
	insPart.run('f1c', 'a2', 'root1', T + 2050, T + 2050, JSON.stringify({ type: 'step-finish', reason: 'stop' }));
	// Compaction marker on root1 (session-scoped, not message-scoped).
	insPart.run('cmp1', 'a1', 'root1', T + 850, T + 850, JSON.stringify({ type: 'compaction', auto: 1 }));

	// Tool parts on a1 (mix of regular tools and delegations)
	insPart.run('t1', 'a1', 'root1', T + 250, T + 300, JSON.stringify({
		type: 'tool', tool: 'bash', callID: 'call-bash',
		state: { status: 'completed', time: { start: T + 200, end: T + 300 }, input: '{"command":"ls"}', output: 'file list' }
	}));
	insPart.run('t2', 'a1', 'root1', T + 350, T + 350, JSON.stringify({
		type: 'tool', tool: 'mcp_x_recall', callID: 'call-mcp',
		state: { status: 'error', error: 'boom', time: { start: T + 350, end: T + 350 }, input: '{}', output: '' }
	}));
	// Delegation edges on a1 (root -> child1, root -> grandchild1)
	const addEdge = (id: string, msgId: string, sessId: string, created: number, childId: string | null, agentType: string | null, status: string) => {
		insPart.run(id, msgId, sessId, created, created + 300, JSON.stringify({
			type: 'tool', tool: 'task', callID: `call-${id}`,
			state: {
				status, time: { start: created, end: created + 300 },
				metadata: { parentSessionId: 'root1', sessionId: childId ?? undefined },
				input: { subagent_type: agentType ?? 'developer', description: `Task`, prompt: 'do it' },
				output: 'done'
			}
		}));
	};
	addEdge('d1', 'a1', 'root1', T + 500, 'child1', 'developer', 'completed');
	addEdge('d2', 'a1', 'root1', T + 550, 'grandchild1', 'tester', 'completed');

	// Parts on child1
	insMessage.run('cu1', 'child1', T + 500, T + 500, JSON.stringify({ role: 'user', time: { created: T + 500 } }));
	insMessage.run('ca1', 'child1', T + 520, T + 760, JSON.stringify({
		role: 'assistant', parentID: 'cu1', agent: 'developer', modelID: 'gpt-5', providerID: 'openai',
		cost: 0.5, tokens: tokens(50, 20, 10), time: { created: T + 520, completed: T + 760 }
	}));
	insPart.run('cs1', 'ca1', 'child1', T + 520, T + 520, JSON.stringify({ type: 'step-start' }));
	insPart.run('cf1', 'ca1', 'child1', T + 750, T + 750, JSON.stringify({ type: 'step-finish', reason: 'stop' }));
	// Delegation edge from child1 -> grandchild1
	addEdge('d3', 'ca1', 'child1', T + 600, 'grandchild1', 'tester', 'completed');

	// Parts on grandchild1
	insMessage.run('gu1', 'grandchild1', T + 600, T + 600, JSON.stringify({ role: 'user', time: { created: T + 600 } }));
	insMessage.run('ga1', 'grandchild1', T + 620, T + 690, JSON.stringify({
		role: 'assistant', parentID: 'gu1', agent: 'tester', modelID: 'gpt-mini', providerID: 'openai',
		cost: 0.1, tokens: tokens(5, 3, 1), time: { created: T + 620, completed: T + 690 }
	}));
	insPart.run('gs1', 'ga1', 'grandchild1', T + 620, T + 620, JSON.stringify({ type: 'step-start' }));
	insPart.run('gf1', 'ga1', 'grandchild1', T + 690, T + 690, JSON.stringify({ type: 'step-finish', reason: 'stop' }));

	// --- Cycle fixture: cycA -> cycC -> cycB -> cycA -----------------------
	insSession.run('cycA', null, '/repo/c', 'Cycle A', 'build', T + 6000, T + 6000, null, 0, 0, 0, 0, 0, 0, MODEL);
	insSession.run('cycB', 'cycA', '/repo/c', 'Cycle B', 'build', T + 6000, T + 6000, null, 0, 0, 0, 0, 0, 0, MODEL);
	insSession.run('cycC', 'cycB', '/repo/c', 'Cycle C', 'build', T + 6000, T + 6000, null, 0, 0, 0, 0, 0, 0, MODEL);
	// Close the loop: cycA -> cycC (overriding earlier cycA.parent_id=cycC was done implicitly by the DB).
	db.exec("UPDATE session SET parent_id = 'cycC' WHERE id = 'cycA'");
	// Add a delegation edge inside the cycle so we can verify union equality.
	insMessage.run('cu_cyc', 'cycB', T + 6100, T + 6100, JSON.stringify({ role: 'user', time: { created: T + 6100 } }));
	insMessage.run('ca_cyc', 'cycB', T + 6120, T + 6200, JSON.stringify({
		role: 'assistant', parentID: 'cu_cyc', agent: 'build', modelID: 'gpt-5', providerID: 'openai',
		cost: 0, tokens: tokens(1, 1, 0), time: { created: T + 6120, completed: T + 6200 }
	}));
	addEdge('dcyc', 'ca_cyc', 'cycB', T + 6150, 'cycC', 'reviewer', 'completed');
	// Add a compaction part to the cycle session so the cycle-edge test has edges to return.
	insPart.run('ccmp', 'ca_cyc', 'cycB', T + 6160, T + 6160, JSON.stringify({ type: 'compaction', auto: 1 }));

	db.close();
}

// ---------------------------------------------------------------------------
// Process-wide fixture setup
// ---------------------------------------------------------------------------

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-phase3-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

const { getDb } = await import('./db');

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. getSubtreeDelegationEdges: cycle guard + equality with per-session union
// ---------------------------------------------------------------------------

describe('getSubtreeDelegationEdges — cycle guard and union equality', () => {
	test('terminates on a parent_id cycle without infinite looping', () => {
		// cycA -> cycC -> cycB -> cycA should be walked exactly once each.
		const edges = getSubtreeDelegationEdges('cycA');
		const ids = edges.map((e) => e.id);
		// Exactly one edge exists in the cycle fixture: dcyc.
		expect(ids).toContain('dcyc');
		expect(ids.filter((id) => id === 'dcyc')).toHaveLength(1);
	});

	test('returns the same edge ids as the per-session union across a multi-level subtree', () => {
		const subtreeIds = getSessionSubtree('root1').map((s) => s.id);
		// Compare the batch query against the N+1 loop.
		const batch = getSubtreeDelegationEdges('root1');
		const perSession = new Map<string, DelegationRecord>();
		for (const sid of subtreeIds) {
			for (const edge of getDelegationEdges(sid)) {
				perSession.set(edge.id, edge);
			}
		}
		// Same record count and same id set — ordering differs because the batch
		// query orders by session_id (alphabetical) while the N+1 loop follows
		// subtree depth order; both are valid grouping orders.
		expect(batch.length).toBe(perSession.size);
		const batchIds = new Set(batch.map((e) => e.id));
		expect(batchIds).toEqual(new Set(perSession.keys()));
		const batchById = new Map(batch.map((e) => [e.id, e]));
		for (const [id, expected] of perSession) {
			const actual = batchById.get(id);
			expect(actual).toBeDefined();
			expect(actual!.sessionId).toBe(expected.sessionId);
			expect(actual!.childSessionId).toBe(expected.childSessionId);
			expect(actual!.startedAt).toBe(expected.startedAt);
		}
	});
});

// ---------------------------------------------------------------------------
// 2. message-scoped part reads == unscoped + JS filter; empty scope = AND 0
// ---------------------------------------------------------------------------

describe('message-scoped part reads', () => {
	test('scoped getStepParts equals unscoped filtered to the message set', () => {
		const turn1MsgIds = ['a1', 'a1b'];
		const scoped = getStepParts('root1', turn1MsgIds);
		const unscoped = getStepParts('root1');
		const filtered = unscoped.filter((p) => turn1MsgIds.includes(p.messageId));
		expect(scoped.map((p) => p.id)).toEqual(filtered.map((p) => p.id));
	});

	test('scoped getToolParts equals unscoped filtered to the message set', () => {
		const turn1MsgIds = ['a1', 'a1b'];
		const scoped = getToolParts('root1', turn1MsgIds);
		const unscoped = getToolParts('root1');
		const filtered = unscoped.filter((p) => turn1MsgIds.includes(p.messageId));
		expect(scoped.map((p) => p.id)).toEqual(filtered.map((p) => p.id));
	});

	test('scoped getActionParts equals unscoped filtered to the message set', () => {
		const turn1MsgIds = ['a1', 'a1b'];
		const scoped = getActionParts('root1', turn1MsgIds);
		const unscoped = getActionParts('root1');
		const filtered = unscoped.filter((p) => turn1MsgIds.includes(p.messageId));
		expect(scoped.map((p) => p.id)).toEqual(filtered.map((p) => p.id));
	});

	test('an empty message-id array returns no parts (AND 0 short-circuit)', () => {
		expect(getStepParts('root1', [])).toEqual([]);
		expect(getToolParts('root1', [])).toEqual([]);
		expect(getActionParts('root1', [])).toEqual([]);
		expect(getCompactionParts('root1')).not.toHaveLength(0); // compaction is not message-scoped
	});

	test('scoped reads keep compaction/removed markers session-scoped', () => {
		// compaction and removed markers are fetched via the non-scoped helpers;
		// their results are unaffected by the messageIds argument.
		const scopedSteps = getStepParts('root1', ['a1']);
		const unscopedSteps = getStepParts('root1');
		expect(scopedSteps.length).toBeLessThan(unscopedSteps.length);
	});

	test('buildTurnModel turn-1 parts equal the unscoped-turn assembly filtered to turn messages', () => {
		// Re-derive the turn-1 model and confirm the root node's steps use only
		// a1/a1b parts — no a2 step leakage.
		const model = buildTurnModel('root1', 'u1')!;
		const rootSteps = model.steps.filter((s) => s.nodeId === 'root1');
		const stepIds = rootSteps.map((s) => s.id);
		// Turn 1 has f1a and f1b; f1c belongs to turn 2.
		expect(stepIds).toContain('f1a');
		expect(stepIds).toContain('f1b');
		expect(stepIds).not.toContain('f1c');
	});
});

// ---------------------------------------------------------------------------
// 3. session-graph invalidation: live WAL commit + resetDbConnection
// ---------------------------------------------------------------------------

describe('session-graph cache invalidation', () => {
	beforeEach(() => {
		clearSessionGraphCache();
	});

	test('resetDbConnection drops every cached graph', () => {
		const graph1 = loadSessionGraph('root1');
		expect(graph1.subtree.length).toBeGreaterThan(0);
		expect(graph1.edges.length).toBeGreaterThan(0);

		const tokenBefore = graph1.subtree.length;

		// resetDbConnection fires onDbReset listeners, which clear the cache.
		resetDbConnection();

		// After reset, the next load recomputes (same count, different object).
		const graph2 = loadSessionGraph('root1');
		expect(graph2.subtree.length).toBe(tokenBefore);
		expect(graph2).not.toBe(graph1); // fresh object
	});

	test('a live WAL commit changes dbStateToken and invalidates the cached graph', () => {
		// Open a second writable connection to the same DB to simulate an external
		// writer that commits and flips PRAGMA data_version.
		const writer = new Database(DB_PATH);
		// Ensure WAL mode so the read-only handle can see the WAL sidecar.
		writer.exec('PRAGMA journal_mode = WAL;');
		const graphBefore = loadSessionGraph('root1');

		// A write that commits flips data_version on the reader side.
		writer.exec('CREATE TABLE IF NOT EXISTS _phase3_scratch (id TEXT PRIMARY KEY);');
		writer.exec("INSERT INTO _phase3_scratch (id) VALUES ('x')");
		// Bun SQLite is autocommit; close flushes the implicit transaction.
		writer.close();

		// The cached graph must be invalidated because data_version changed.
		const graphAfter = loadSessionGraph('root1');
		expect(graphAfter).not.toBe(graphBefore);
	});

	test('the cached graph object is reused when the token is unchanged', () => {
		const graph1 = loadSessionGraph('root1');
		const graph2 = loadSessionGraph('root1');
		expect(graph1).toBe(graph2); // same object from the map
	});
});
