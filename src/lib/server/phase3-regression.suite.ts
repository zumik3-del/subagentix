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
 *   2. message-scoped content-item reads equal unscoped+filter, including the empty-scope
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
import { getActionParts, getCompactionParts, getToolParts } from './queries/messages';
import type { DelegationRecord } from './schema';
import {
	applyV2Schema,
	addSessionV2,
	addUserMessage,
	addAssistantMessage,
	addCompactionMessage,
	toolItem,
	subagentItem,
	T,
} from './test-fixtures/opencode-v2';

const MODEL = { id: 'gpt-5', providerID: 'openai' };

// ---------------------------------------------------------------------------
// Fixture builder — mirrors data-layer.suite.ts + adds WAL-write helpers.
// ---------------------------------------------------------------------------

function buildFixture(path: string): void {
	const db = new Database(path);
	applyV2Schema(db);

	const future = Date.now() + 10_000_000;

	// --- root1: two turns ---------------------------------------------------
	addSessionV2(db, { id: 'root1', dir: '/repo/a', title: 'Root one', agent: 'build', created: T + 50, updated: T + 900, cost: 2, tokens: { input: 310, output: 125, reasoning: 40, cacheRead: 20, cacheWrite: 10 }, model: MODEL });
	addSessionV2(db, { id: 'child1', parentId: 'root1', dir: '/repo/a', title: 'Child one', agent: 'developer', created: T + 500, updated: T + 2500, cost: 0.5, tokens: { input: 50, output: 20, reasoning: 10 }, model: MODEL });
	addSessionV2(db, { id: 'grandchild1', parentId: 'child1', dir: '/repo/a', title: 'Grandchild', agent: 'tester', created: T + 600, updated: T + 690, cost: 0.1, tokens: { input: 5, output: 3, reasoning: 1 }, model: { id: 'gpt-mini', providerID: 'openai' } });

	// Turn 1 messages (trigger u1, assistants a1, a1b)
	addUserMessage(db, { id: 'u1', sessionId: 'root1', seq: 1, created: T + 100, text: 'prompt' });
	addAssistantMessage(db, {
		id: 'a1', sessionId: 'root1', seq: 2, created: T + 150, completed: T + 900,
		agent: 'build', model: MODEL,
		cost: 2, tokens: { input: 300, output: 120, reasoning: 40, cacheRead: 20, cacheWrite: 10 },
		finish: 'tool-calls',
		content: [
			toolItem('bash', { id: 't1', status: 'completed', input: { command: 'ls' }, text: 'file list', created: T + 250, ran: T + 250, completed: T + 300 }),
			toolItem('mcp_recall', { id: 't2', status: 'error', input: {}, error: { type: 'error', message: 'boom' }, created: T + 350, ran: T + 350, completed: T + 350 }),
			subagentItem({ id: 'd1', childSessionId: 'child1', agent: 'developer', description: 'build feature', prompt: 'do it', status: 'completed', text: 'done', created: T + 500, ran: T + 500, completed: T + 800 }),
			subagentItem({ id: 'd2', childSessionId: 'grandchild1', agent: 'tester', description: 'tests', prompt: 'do it', status: 'completed', text: 'done', created: T + 550, ran: T + 550, completed: T + 690 }),
		],
	});
	addAssistantMessage(db, {
		id: 'a1b', sessionId: 'root1', seq: 3, created: T + 200, completed: T + 400,
		agent: 'build', model: MODEL,
		cost: 0, tokens: { input: 10, output: 5, reasoning: 0 },
		finish: 'stop',
		content: [],
	});
	// Turn 2 message (trigger u2, assistant a2)
	addUserMessage(db, { id: 'u2', sessionId: 'root1', seq: 4, created: T + 2000, text: 'prompt 2' });
	addAssistantMessage(db, {
		id: 'a2', sessionId: 'root1', seq: 5, created: T + 2010, completed: T + 2100,
		agent: 'build', model: MODEL,
		cost: 0, tokens: { input: 20, output: 10, reasoning: 5 },
		finish: 'stop',
		content: [],
	});
	// Compaction marker on root1.
	addCompactionMessage(db, { id: 'cmp1', sessionId: 'root1', seq: 6, created: T + 850 });

	// child1 messages
	addUserMessage(db, { id: 'cu1', sessionId: 'child1', seq: 1, created: T + 500, text: 'prompt' });
	addAssistantMessage(db, {
		id: 'ca1', sessionId: 'child1', seq: 2, created: T + 520, completed: T + 760,
		agent: 'developer', model: MODEL,
		cost: 0.5, tokens: { input: 50, output: 20, reasoning: 10 },
		finish: 'stop',
		content: [
			subagentItem({ id: 'd3', childSessionId: 'grandchild1', agent: 'tester', description: 'tests', prompt: 'do it', status: 'completed', text: 'ok', created: T + 600, ran: T + 600, completed: T + 700 }),
		],
	});

	// grandchild1 messages
	addUserMessage(db, { id: 'gu1', sessionId: 'grandchild1', seq: 1, created: T + 600, text: 'prompt' });
	addAssistantMessage(db, {
		id: 'ga1', sessionId: 'grandchild1', seq: 2, created: T + 620, completed: T + 690,
		agent: 'tester', model: { id: 'gpt-mini', providerID: 'openai' },
		cost: 0.1, tokens: { input: 5, output: 3, reasoning: 1 },
		finish: 'stop',
		content: [],
	});

	// --- Cycle fixture: cycA -> cycC -> cycB -> cycA -----------------------
	addSessionV2(db, { id: 'cycA', dir: '/repo/c', title: 'Cycle A', agent: 'build', created: T + 6000, updated: T + 6000, cost: 0, tokens: { input: 0, output: 0, reasoning: 0 }, model: MODEL });
	addSessionV2(db, { id: 'cycB', parentId: 'cycA', dir: '/repo/c', title: 'Cycle B', agent: 'build', created: T + 6000, updated: T + 6000, cost: 0, tokens: { input: 0, output: 0, reasoning: 0 }, model: MODEL });
	addSessionV2(db, { id: 'cycC', parentId: 'cycB', dir: '/repo/c', title: 'Cycle C', agent: 'build', created: T + 6000, updated: T + 6000, cost: 0, tokens: { input: 0, output: 0, reasoning: 0 }, model: MODEL });
	// Close the loop: cycA.parent_id = cycC.
	db.prepare('UPDATE session_v2 SET parent_id = ? WHERE id = ?').run('cycC', 'cycA');
	// Add a delegation edge inside the cycle so we can verify union equality.
	addUserMessage(db, { id: 'cu_cyc', sessionId: 'cycB', seq: 1, created: T + 6100, text: 'prompt' });
	addAssistantMessage(db, {
		id: 'ca_cyc', sessionId: 'cycB', seq: 2, created: T + 6120, completed: T + 6200,
		agent: 'build', model: MODEL,
		cost: 0, tokens: { input: 1, output: 1, reasoning: 0 },
		finish: 'stop',
		content: [
			subagentItem({ id: 'dcyc', childSessionId: 'cycC', agent: 'reviewer', description: 'review', prompt: 'do it', status: 'completed', text: 'done', created: T + 6150, ran: T + 6150, completed: T + 6200 }),
		],
	});
	// Add a compaction message to the cycle session.
	addCompactionMessage(db, { id: 'ccmp', sessionId: 'cycB', seq: 3, created: T + 6160 });

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
		// Exactly one edge exists in the cycle fixture: ca_cyc#0 (V2 synthesizes edge ids as messageId#index).
		expect(ids).toContain('ca_cyc#0');
		expect(ids.filter((id) => id === 'ca_cyc#0')).toHaveLength(1);
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
// 2. message-scoped content-item reads == unscoped + JS filter; empty scope = AND 0
// ---------------------------------------------------------------------------

describe('message-scoped content-item reads', () => {
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
		expect(getToolParts('root1', [])).toEqual([]);
		expect(getActionParts('root1', [])).toEqual([]);
		expect(getCompactionParts('root1')).not.toHaveLength(0); // compaction is not message-scoped
	});

	test('buildTurnModel turn-1 steps equal the assistant messages in the turn', () => {
		// Re-derive the turn-1 model and confirm the root node's steps are
		// exactly the assistant messages a1/a1b — no a2 leakage.
		const model = buildTurnModel('root1', 'u1')!;
		const rootSteps = model.steps.filter((s) => s.nodeId === 'root1');
		const stepIds = rootSteps.map((s) => s.id);
		// Turn 1 has a1 and a1b as steps.
		expect(stepIds).toContain('a1');
		expect(stepIds).toContain('a1b');
		expect(stepIds).not.toContain('a2');
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
