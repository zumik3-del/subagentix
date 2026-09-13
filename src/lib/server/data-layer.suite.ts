/**
 * M2 data-layer suite (task #185, ADR §6 / §7.1 / §8).
 *
 * This file intentionally has NO `.test` suffix. It builds a real fixture
 * SQLite DB, points `OPENCODE_DB` at it and imports the real db/query/service
 * modules. `health.test.ts` registers a process-wide `mock.module` for
 * `$lib/server/db` and bun's `mock.module` cannot be undone, so any suite that
 * exercises the real db module must run in an isolated child process; the
 * wrapper `data-layer.test.ts` spawns `bun test` on this file and asserts
 * `0 fail` (pattern from the synaptomind repo: bun mock.module leak).
 *
 * Everything runs against a throwaway fixture under the OS temp dir; the live
 * `/home/opencode/.local/share/opencode/opencode.db` is never opened or
 * written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const T = 1_700_000_000_000;

interface SessionSeed {
	id: string;
	parentId?: string | null;
	dir: string;
	title: string;
	agent?: string | null;
	created: number;
	updated: number;
	archived?: number | null;
	cost: number;
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	model?: string | null;
}

interface MessageSeed {
	id: string;
	sessionId: string;
	created: number;
	updated: number;
	data: Record<string, unknown>;
}

interface PartSeed {
	id: string;
	messageId: string;
	sessionId: string;
	created: number;
	updated: number;
	data: Record<string, unknown>;
}

interface EventSeed {
	id: string;
	aggregateId: string;
	seq: number;
	type: string;
	data: Record<string, unknown>;
}

/** Build a small opencode-shaped fixture: session/message/part/event tables. */
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
	const addSession = (s: SessionSeed) =>
		insSession.run(
			s.id,
			s.parentId ?? null,
			s.dir,
			s.title,
			s.agent ?? null,
			s.created,
			s.updated,
			s.archived ?? null,
			s.cost,
			s.input,
			s.output,
			s.reasoning,
			s.cacheRead,
			s.cacheWrite,
			s.model ?? null
		);

	const insMessage = db.prepare(
		'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
	);
	const addMessage = (m: MessageSeed) =>
		insMessage.run(m.id, m.sessionId, m.created, m.updated, JSON.stringify(m.data));

	const insPart = db.prepare(
		'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
	);
	const addPart = (p: PartSeed) =>
		insPart.run(p.id, p.messageId, p.sessionId, p.created, p.updated, JSON.stringify(p.data));

	const insEvent = db.prepare(
		'INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)'
	);
	const addEvent = (e: EventSeed) =>
		insEvent.run(e.id, e.aggregateId, e.seq, e.type, JSON.stringify(e.data));

	const tokens = (input: number, output: number, reasoning: number, read = 0, write = 0) => ({
		input,
		output,
		reasoning,
		cache: { read, write }
	});

	const future = Date.now() + 10_000_000;

	// --- sessions ---------------------------------------------------------
	addSession({ id: 'root1', dir: '/repo/a', title: 'Root one', agent: 'build', created: T + 50, updated: T + 900, cost: 2, input: 310, output: 125, reasoning: 40, cacheRead: 20, cacheWrite: 10, model: JSON.stringify({ id: 'gpt-5', providerID: 'openai' }) });
	addSession({ id: 'child1', parentId: 'root1', dir: '/repo/a', title: 'Child one', agent: 'developer', created: T + 500, updated: T + 2500, cost: 0.5, input: 50, output: 20, reasoning: 10, cacheRead: 0, cacheWrite: 0, model: JSON.stringify({ id: 'gpt-5', providerID: 'openai' }) });
	addSession({ id: 'child2', parentId: 'root1', dir: '/repo/a', title: 'Child two', agent: null, created: T + 700, updated: T + 760, archived: T + 760, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, model: null });
	addSession({ id: 'grandchild1', parentId: 'child1', dir: '/repo/a', title: 'Grandchild', agent: 'tester', created: T + 600, updated: T + 690, cost: 0.1, input: 5, output: 3, reasoning: 1, cacheRead: 0, cacheWrite: 0, model: JSON.stringify({ id: 'gpt-mini', providerID: 'openai' }) });
	addSession({ id: 'root2', dir: '/repo/b', title: 'Root two', agent: null, created: T + 1500, updated: T + 1600, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, model: null });
	addSession({ id: 'runRoot', dir: '/repo/a', title: 'Running root', agent: 'build', created: T + 3000, updated: T + 3055, cost: 0, input: 30, output: 15, reasoning: 5, cacheRead: 0, cacheWrite: 0, model: JSON.stringify({ id: 'gpt-5', providerID: 'openai' }) });
	addSession({ id: 'runChild', parentId: 'runRoot', dir: '/repo/a', title: 'Running child', agent: 'developer', created: T + 3050, updated: T + 3055, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, model: null });
	addSession({ id: 'badRoot', dir: '/repo/a', title: 'Bad span', agent: 'build', created: T + 4000, updated: T + 3900, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, model: null });
	addSession({ id: 'futureRoot', dir: '/repo/a', title: 'Future span', agent: 'build', created: T + 5000, updated: future, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, model: null });
	addSession({ id: 'cycA', dir: '/repo/c', title: 'Cycle A', agent: 'build', created: T + 6000, updated: T + 6000, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, model: null });
	addSession({ id: 'cycB', parentId: 'cycA', dir: '/repo/c', title: 'Cycle B', agent: 'build', created: T + 6000, updated: T + 6000, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, model: null });
	addSession({ id: 'cycC', parentId: 'cycB', dir: '/repo/c', title: 'Cycle C', agent: 'build', created: T + 6000, updated: T + 6000, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, model: null });
	// Close the loop: cycA -> cycC -> cycB -> cycA (must not loop the CTE).
	db.exec("UPDATE session SET parent_id = 'cycC' WHERE id = 'cycA'");

	// --- root1 messages (two turns) --------------------------------------
	addMessage({ id: 'u1', sessionId: 'root1', created: T + 100, updated: T + 100, data: { role: 'user', time: { created: T + 100 } } });
	addMessage({ id: 'a1', sessionId: 'root1', created: T + 150, updated: T + 900, data: { role: 'assistant', parentID: 'u1', agent: 'build', modelID: 'gpt-5', providerID: 'openai', cost: 2, tokens: tokens(300, 120, 40, 20, 10), time: { created: T + 150, completed: T + 900 } } });
	addMessage({ id: 'a1b', sessionId: 'root1', created: T + 200, updated: T + 400, data: { role: 'assistant', parentID: 'u1', agent: 'build', modelID: 'gpt-5', providerID: 'openai', cost: 0, tokens: tokens(10, 5, 0), time: { created: T + 200, completed: T + 400 } } });
	addMessage({ id: 'u2', sessionId: 'root1', created: T + 2000, updated: T + 2000, data: { role: 'user', time: { created: T + 2000 } } });
	addMessage({ id: 'a2', sessionId: 'root1', created: T + 2010, updated: T + 2100, data: { role: 'assistant', parentID: 'u2', agent: 'build', modelID: 'gpt-5', providerID: 'openai', cost: 0, tokens: tokens(20, 10, 5), time: { created: T + 2010, completed: T + 2100 } } });

	// --- child1 / grandchild1 / runRoot / badRoot / futureRoot ------------
	addMessage({ id: 'cu1', sessionId: 'child1', created: T + 500, updated: T + 500, data: { role: 'user', time: { created: T + 500 } } });
	addMessage({ id: 'ca1', sessionId: 'child1', created: T + 520, updated: T + 760, data: { role: 'assistant', parentID: 'cu1', agent: 'developer', modelID: 'gpt-5', providerID: 'openai', cost: 0.5, tokens: tokens(50, 20, 10), time: { created: T + 520, completed: T + 760 } } });
	addMessage({ id: 'gu1', sessionId: 'grandchild1', created: T + 600, updated: T + 600, data: { role: 'user', time: { created: T + 600 } } });
	addMessage({ id: 'ga1', sessionId: 'grandchild1', created: T + 620, updated: T + 690, data: { role: 'assistant', parentID: 'gu1', agent: 'tester', modelID: 'gpt-mini', providerID: 'openai', cost: 0.1, tokens: tokens(5, 3, 1), time: { created: T + 620, completed: T + 690 } } });
	addMessage({ id: 'ru1', sessionId: 'runRoot', created: T + 3000, updated: T + 3000, data: { role: 'user', time: { created: T + 3000 } } });
	addMessage({ id: 'ra1', sessionId: 'runRoot', created: T + 3000, updated: T + 3040, data: { role: 'assistant', parentID: 'ru1', agent: 'build', modelID: 'gpt-5', providerID: 'openai', cost: 0, tokens: tokens(30, 15, 5), time: { created: T + 3000 } } });
	addMessage({ id: 'u_bad', sessionId: 'badRoot', created: T + 4000, updated: T + 4000, data: { role: 'user', time: { created: T + 4000 } } });
	addMessage({ id: 'a_bad', sessionId: 'badRoot', created: T + 4000, updated: T + 4000, data: { role: 'assistant', parentID: 'u_bad', agent: 'build', cost: 0, tokens: tokens(0, 0, 0), time: { created: T + 4000, completed: T + 3900 } } });
	addMessage({ id: 'u_fut', sessionId: 'futureRoot', created: T + 5000, updated: T + 5000, data: { role: 'user', time: { created: T + 5000 } } });
	addMessage({ id: 'a_fut', sessionId: 'futureRoot', created: T + 5000, updated: future, data: { role: 'assistant', parentID: 'u_fut', agent: 'build', cost: 0, tokens: tokens(0, 0, 0), time: { created: T + 5000, completed: future } } });

	// --- root1 parts: steps, tools, compaction, delegations ---------------
	addPart({ id: 's1a', messageId: 'a1', sessionId: 'root1', created: T + 150, updated: T + 150, data: { type: 'step-start' } });
	addPart({ id: 'f1a', messageId: 'a1', sessionId: 'root1', created: T + 790, updated: T + 790, data: { type: 'step-finish', reason: 'tool-calls', tokens: tokens(150, 60, 20, 10, 5), cost: 1 } });
	addPart({ id: 's2a', messageId: 'a1', sessionId: 'root1', created: T + 800, updated: T + 800, data: { type: 'step-start' } });
	addPart({ id: 'f2a', messageId: 'a1', sessionId: 'root1', created: T + 900, updated: T + 900, data: { type: 'step-finish', reason: 'stop', tokens: tokens(150, 60, 20, 10, 5), cost: 1 } });
	addPart({ id: 's1b', messageId: 'a1b', sessionId: 'root1', created: T + 200, updated: T + 200, data: { type: 'step-start' } });
	addPart({ id: 'f1b', messageId: 'a1b', sessionId: 'root1', created: T + 300, updated: T + 300, data: { type: 'step-finish', reason: 'stop', tokens: tokens(10, 5, 0), cost: 0 } });
	addPart({ id: 's1c', messageId: 'a2', sessionId: 'root1', created: T + 2010, updated: T + 2010, data: { type: 'step-start' } });
	addPart({ id: 'f1c', messageId: 'a2', sessionId: 'root1', created: T + 2050, updated: T + 2050, data: { type: 'step-finish', reason: 'stop', tokens: tokens(20, 10, 5), cost: 0 } });

	addPart({ id: 't1', messageId: 'a1', sessionId: 'root1', created: T + 250, updated: T + 300, data: { type: 'tool', tool: 'bash', callID: 'call-bash', state: { status: 'completed', time: { start: T + 200, end: T + 300 }, input: '{"command":"ls"}', output: 'file list' } } });
	addPart({ id: 't2', messageId: 'a1', sessionId: 'root1', created: T + 350, updated: T + 350, data: { type: 'tool', tool: 'mcp_synaptomind_memory_recall', callID: 'call-mcp', state: { status: 'error', error: 'boom', time: { start: T + 350, end: T + 340 }, input: '{}', output: '' } } });
	addPart({ id: 't3', messageId: 'a1', sessionId: 'root1', created: T + 380, updated: T + 390, data: { type: 'tool', tool: 'ziptask_claim_task', callID: 'call-zt', state: { status: 'completed', time: { start: T + 380, end: T + 390 }, input: '{"task_id":185}', output: '{"id":185}' } } });
	addPart({ id: 't4', messageId: 'a1', sessionId: 'root1', created: T + 400, updated: T + 400, data: { type: 'tool', tool: 'read', callID: 'call-read', state: { status: 'completed', time: { start: T + 400, end: future }, input: '{}', output: 'x' } } });
	addPart({ id: 't5', messageId: 'a1', sessionId: 'root1', created: T + 855, updated: T + 860, data: { type: 'tool', tool: 'write', callID: 'call-write', state: { status: 'completed', time: { start: T + 850, end: T + 860 }, input: '{}', output: 'ok' } } });
	addPart({ id: 'cmp1', messageId: 'a1', sessionId: 'root1', created: T + 850, updated: T + 850, data: { type: 'compaction', auto: 1 } });

	const ztEdge = (
		id: string,
		created: number,
		updated: number,
		state: Record<string, unknown>
	): PartSeed => ({
		id,
		messageId: 'a1',
		sessionId: 'root1',
		created,
		updated,
		data: { type: 'tool', tool: 'task', callID: `call-${id}`, state }
	});
	addPart(ztEdge('d_orphan', T + 50, T + 60, { status: 'completed', time: { start: T + 50, end: T + 60 }, metadata: { parentSessionId: 'root1', sessionId: 'child2' }, input: { subagent_type: 'reviewer', description: 'old', prompt: 'legacy' }, output: 'ok' }));
	addPart(ztEdge('d1', T + 500, T + 800, { status: 'completed', time: { start: T + 500, end: T + 800 }, metadata: { parentSessionId: 'root1', sessionId: 'child1' }, input: { subagent_type: 'developer', description: 'build feature', prompt: 'Task #42 build it' }, output: 'child result' }));
	addPart(ztEdge('d4', T + 700, T + 750, { status: 'completed', time: { start: T + 700, end: T + 750 }, metadata: { parentSessionId: 'root1', sessionId: 'child2' }, input: { subagent_type: 'reviewer', description: 'review', prompt: 'Task #43 review' }, output: 'done' }));
	addPart(ztEdge('d3', T + 1500, T + 1600, { status: 'error', error: 'spawn failed', time: { start: T + 1500, end: T + 1600 }, metadata: { parentSessionId: 'root1' }, input: { subagent_type: 'broken', description: 'nope', prompt: 'no prompt' }, output: '' }));

	// --- child1 parts: step + grandchild delegation -----------------------
	addPart({ id: 's1d', messageId: 'ca1', sessionId: 'child1', created: T + 520, updated: T + 520, data: { type: 'step-start' } });
	addPart({ id: 'f1d', messageId: 'ca1', sessionId: 'child1', created: T + 750, updated: T + 750, data: { type: 'step-finish', reason: 'stop', tokens: tokens(50, 20, 10), cost: 0.5 } });
	addPart({ id: 'cmp2', messageId: 'ca1', sessionId: 'child1', created: T + 650, updated: T + 650, data: { type: 'compaction', auto: 1 } });
	addPart({ id: 'd2', messageId: 'ca1', sessionId: 'child1', created: T + 600, updated: T + 700, data: { type: 'tool', tool: 'task', callID: 'call-d2', state: { status: 'completed', time: { start: T + 600, end: T + 700 }, metadata: { parentSessionId: 'child1', sessionId: 'grandchild1' }, input: { subagent_type: 'tester', description: 'tests', prompt: 'Task #44 test' }, output: 'tested' } } });

	// --- grandchild1 step -------------------------------------------------
	addPart({ id: 's1e', messageId: 'ga1', sessionId: 'grandchild1', created: T + 620, updated: T + 620, data: { type: 'step-start' } });
	addPart({ id: 'f1e', messageId: 'ga1', sessionId: 'grandchild1', created: T + 690, updated: T + 690, data: { type: 'step-finish', reason: 'stop', tokens: tokens(5, 3, 1), cost: 0.1 } });

	// --- runRoot: open step + running tool/edge ---------------------------
	addPart({ id: 'rs0', messageId: 'ra1', sessionId: 'runRoot', created: T + 3000, updated: T + 3000, data: { type: 'step-start' } });
	addPart({ id: 'rf0', messageId: 'ra1', sessionId: 'runRoot', created: T + 3020, updated: T + 3020, data: { type: 'step-finish', reason: 'tool-calls', tokens: tokens(10, 5, 2), cost: 0 } });
	addPart({ id: 'rs1', messageId: 'ra1', sessionId: 'runRoot', created: T + 3040, updated: T + 3040, data: { type: 'step-start' } });
	addPart({ id: 'rt_run', messageId: 'ra1', sessionId: 'runRoot', created: T + 3050, updated: T + 3050, data: { type: 'tool', tool: 'task', callID: 'call-run', state: { status: 'running', time: { start: T + 3050 }, metadata: { parentSessionId: 'runRoot', sessionId: 'runChild' }, input: { subagent_type: 'developer', description: 'running', prompt: 'Task #50' }, output: '' } } });
	addPart({ id: 'rt_bash', messageId: 'ra1', sessionId: 'runRoot', created: T + 3055, updated: T + 3055, data: { type: 'tool', tool: 'bash', callID: 'call-bash-run', state: { status: 'running', time: { start: T + 3055 }, input: '{}', output: '' } } });

	// --- events: message.removed markers ---------------------------------
	addEvent({ id: 'e1', aggregateId: 'root1', seq: 1, type: 'message.removed.1', data: { messageID: 'a-old' } });
	addEvent({ id: 'e2', aggregateId: 'root1', seq: 2, type: 'message.updated.1', data: { messageID: 'a-old' } });
	addEvent({ id: 'e3', aggregateId: 'child1', seq: 1, type: 'message.removed.1', data: { messageID: 'ca-old' } });
	addEvent({ id: 'e4', aggregateId: 'other', seq: 1, type: 'message.removed.1', data: { messageID: 'x' } });

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-data-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

const { getDb } = await import('./db');
const { listRecentRootSessions, getSessionSubtree, getDelegationEdges } = await import(
	'./queries/sessions'
);
const {
	getMessages,
	getStepParts,
	getToolParts,
	getCompactionParts,
	getRemovedMarkers
} = await import('./queries/parts');
const { buildTurnModel } = await import('./services/turn');
const {
	jsonEquals,
	jsonExtract,
	jsonIn,
	mapDelegationRow,
	mapPartRow,
	mapRemovedMarkerRow,
	mapSessionRow,
	tokenCounts
} = await import('./schema');

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('schema row mappers', () => {
	test('tokenCounts falls back to 0 for missing/null categories', () => {
		expect(tokenCounts({})).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
		expect(tokenCounts({ tok_input: '7', tok_output: null, tok_reasoning: 3 })).toEqual({
			input: 7,
			output: 0,
			reasoning: 3,
			cacheRead: 0,
			cacheWrite: 0
		});
	});

	test('mapSessionRow normalizes nulls and derives usage/cost', () => {
		const record = mapSessionRow({
			id: 'x',
			parent_id: null,
			directory: null,
			title: null,
			agent: null,
			time_created: '10',
			time_updated: null,
			time_archived: null,
			cost: null,
			tokens_input: 1,
			tokens_output: 2,
			tokens_reasoning: 3,
			tokens_cache_read: 4,
			tokens_cache_write: 5,
			model_id: null,
			provider_id: null
		});
		expect(record).toEqual({
			id: 'x',
			parentId: null,
			directory: '',
			title: '',
			agent: null,
			modelId: null,
			providerId: null,
			createdAt: 10,
			updatedAt: 0,
			archivedAt: null,
			cost: 0,
			usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }
		});
	});

	test('mapDelegationRow derives resultBytes and defaults status to unknown', () => {
		const record = mapDelegationRow({
			id: 'd',
			message_id: 'm',
			session_id: 's',
			time_created: '5',
			parent_session_id: 'p',
			child_session_id: null,
			subagent_type: null,
			state_status: null,
			state_error: null,
			state_start: null,
			state_end: null,
			state_output: 'abcd',
			description: null,
			prompt: null
		});
		expect(record.status).toBe('unknown');
		expect(record.resultBytes).toBe(4);
		expect(record.childSessionId).toBeNull();
	});

	test('mapPartRow keeps null optional fields and maps JSON paths', () => {
		const record = mapPartRow({ id: 'p', message_id: 'm', session_id: 's', time_created: 1, time_updated: 2 });
		expect(record.type).toBeNull();
		expect(record.stateStart).toBeNull();
		expect(record.usage).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test('mapRemovedMarkerRow keeps a null message id when the event has none', () => {
		expect(mapRemovedMarkerRow({ session_id: 's', message_id: null })).toEqual({
			sessionId: 's',
			messageId: null
		});
	});

	test('JSON helpers build escaped, index-free predicates', () => {
		expect(jsonExtract('p.data', '$.type', 't')).toBe("json_extract(p.data, '$.type') AS t");
		expect(jsonEquals('part.data', '$.tool', "a'b")).toBe(
			"json_extract(part.data, '$.tool') = 'a''b'"
		);
		expect(jsonIn('p.data', '$.type', ['x', 2])).toBe("json_extract(p.data, '$.type') IN ('x', 2)");
	});
});

describe('queries/sessions against the fixture DB', () => {
	test('getSessionSubtree walks the recursive CTE with depth', () => {
		const rows = getSessionSubtree('root1');
		expect(rows.map((row) => [row.id, row.depth])).toEqual([
			['root1', 0],
			['child1', 1],
			['child2', 1],
			['grandchild1', 2]
		]);
	});

	test('getSessionSubtree terminates on a parent_id cycle', () => {
		const rows = getSessionSubtree('cycA');
		expect(rows.map((row) => row.id).sort()).toEqual(['cycA', 'cycB', 'cycC']);
		expect(new Map(rows.map((row) => [row.id, row.depth]))).toEqual(
			new Map([
				['cycA', 0],
				['cycB', 1],
				['cycC', 2]
			])
		);
	});

	test('getDelegationEdges returns only task parts, ordered by time', () => {
		const edges = getDelegationEdges('root1');
		expect(edges.map((edge) => edge.id)).toEqual(['d_orphan', 'd1', 'd4', 'd3']);
		const d1 = edges.find((edge) => edge.id === 'd1');
		expect(d1).toMatchObject({
			parentSessionId: 'root1',
			childSessionId: 'child1',
			subagentType: 'developer',
			status: 'completed',
			startedAt: T + 500,
			endedAt: T + 800,
			resultBytes: 'child result'.length,
			description: 'build feature'
		});
		expect(edges.find((edge) => edge.id === 'd3')?.childSessionId).toBeNull();
	});

	test('listRecentRootSessions returns roots newest-first with child counts', () => {
		const list = listRecentRootSessions(50);
		const ids = list.map((session) => session.id);
		expect(ids).toContain('root1');
		expect(ids).not.toContain('child1');
		expect(ids).not.toContain('grandchild1');
		const root1 = list.find((session) => session.id === 'root1');
		expect(root1?.childCount).toBe(2);
		expect(list.find((session) => session.id === 'root2')?.agent).toBe('unknown');
		// Newest first.
		expect(ids.indexOf('futureRoot')).toBeLessThan(ids.indexOf('root1'));
	});

	test('getMessages classifies roles and turn parents', () => {
		const messages = getMessages('root1');
		expect(messages.map((message) => message.id)).toEqual(['u1', 'a1', 'a1b', 'u2', 'a2']);
		const users = messages.filter((message) => message.role === 'user').map((message) => message.id);
		expect(users).toEqual(['u1', 'u2']);
		const turn0 = messages
			.filter((message) => message.role === 'assistant' && message.parentId === 'u1')
			.map((message) => message.id);
		expect(turn0).toEqual(['a1', 'a1b']);
		expect(messages.find((message) => message.id === 'a1')?.usage).toEqual({
			input: 300,
			output: 120,
			reasoning: 40,
			cacheRead: 20,
			cacheWrite: 10
		});
	});

	test('getStepParts returns step-start/step-finish only', () => {
		const parts = getStepParts('root1');
		expect(parts.map((part) => part.id)).toEqual(['s1a', 's1b', 'f1b', 'f1a', 's2a', 'f2a', 's1c', 'f1c']);
		expect(parts.every((part) => part.type === 'step-start' || part.type === 'step-finish')).toBe(true);
		expect(parts.every((part) => part.type !== 'tool' && part.type !== 'compaction')).toBe(true);
	});

	test('getToolParts returns tool parts only, including delegations', () => {
		const names = getToolParts('root1').map((part) => part.tool);
		expect(names).toEqual(['task', 'bash', 'mcp_synaptomind_memory_recall', 'ziptask_claim_task', 'read', 'task', 'task', 'write', 'task']);
	});

	test('getCompactionParts returns compaction markers only', () => {
		const parts = getCompactionParts('root1');
		expect(parts.map((part) => part.id)).toEqual(['cmp1']);
		expect(parts[0].auto).toBe(1);
	});

	test('getRemovedMarkers reads only message.removed events for the session', () => {
		expect(getRemovedMarkers('root1')).toEqual([{ sessionId: 'root1', messageId: 'a-old' }]);
		expect(getRemovedMarkers('child1')).toEqual([{ sessionId: 'child1', messageId: 'ca-old' }]);
		expect(getRemovedMarkers('other')).toEqual([{ sessionId: 'other', messageId: 'x' }]);
	});
});

describe('buildTurnModel — turn 1 (u1)', () => {
	const model = buildTurnModel('root1', 'u1')!;

	test('returns a turn anchored at the trigger message, not session.time_created', () => {
		expect(model.turnId).toBe('root1_u1');
		expect(model.rootSessionId).toBe('root1');
		expect(model.agent).toBe('build');
		expect(model.t0).toBe(T + 100);
		const root = model.nodes.find((node) => node.sessionId === 'root1');
		expect(root?.startedAt).toBe(T + 100);
		expect(root?.startedAt).not.toBe(T + 50); // session.time_created != first message time
	});

	test('includes exactly the root, its turn-1 children and the grandchild', () => {
		expect(model.nodes.map((node) => node.sessionId).sort()).toEqual([
			'child1',
			'child2',
			'grandchild1',
			'root1'
		]);
		const byId = new Map(model.nodes.map((node) => [node.sessionId, node]));
		expect(byId.get('root1')?.kind).toBe('orchestrator');
		expect(byId.get('root1')?.depth).toBe(0);
		expect(byId.get('child1')?.kind).toBe('subagent');
		expect(byId.get('grandchild1')?.depth).toBe(2);
		expect(byId.get('child1')?.status).toBe('completed');
		expect(byId.get('child2')?.status).toBe('archived');
	});

	test('falls back to the spawn edge subagent_type when session.agent is null', () => {
		const child2 = model.nodes.find((node) => node.sessionId === 'child2');
		expect(child2?.agent).toBe('reviewer');
		expect(child2?.flags).toContain('multiSpawn');
	});

	test('flags a node whose raw end crosses the next turn and an orphan edge', () => {
		const byId = new Map(model.nodes.map((node) => [node.sessionId, node]));
		expect(byId.get('child1')?.flags).toContain('overlapsNextTurn');
		expect(byId.get('root1')?.flags).toContain('orphanEdge');
	});

	test('sums step usage per node (root excludes the other turn)', () => {
		const byId = new Map(model.nodes.map((node) => [node.sessionId, node]));
		expect(byId.get('root1')?.usage).toEqual({
			input: 310,
			output: 125,
			reasoning: 40,
			cacheRead: 20,
			cacheWrite: 10,
			total: 505,
			cost: 2
		});
		expect(byId.get('child1')?.usage).toEqual({
			input: 50,
			output: 20,
			reasoning: 10,
			cacheRead: 0,
			cacheWrite: 0,
			total: 80,
			cost: 0.5
		});
		expect(byId.get('child2')?.usage.total).toBe(0);
	});

	test('counts steps/tools/errors/compactions and restricts root steps to the turn', () => {
		const root = model.nodes.find((node) => node.sessionId === 'root1');
		// 5 non-task tools + 4 task delegations; t2 and d3 failed.
		expect(root).toMatchObject({ stepCount: 3, toolCallCount: 9, errorCount: 2, compactionCount: 1 });
		const rootSteps = model.steps.filter((step) => step.nodeId === 'root1');
		expect(rootSteps.map((step) => step.messageId)).toEqual(['a1', 'a1', 'a1b']);
		expect(rootSteps.map((step) => step.id).sort()).toEqual(['f1a', 'f1b', 'f2a']);
	});

	test('pairs step-start/step-finish and marks compaction between them', () => {
		const f1a = model.steps.find((step) => step.id === 'f1a');
		const f2a = model.steps.find((step) => step.id === 'f2a');
		expect(f1a).toMatchObject({ startedAt: T + 150, endedAt: T + 790, open: false, hasCompaction: false });
		expect(f2a?.hasCompaction).toBe(true);
		expect(f1a?.usage).toEqual({
			input: 150,
			output: 60,
			reasoning: 20,
			cacheRead: 10,
			cacheWrite: 5,
			total: 245,
			cost: 1
		});
	});

	test('attributes tool calls to the latest closed step and flags bad spans', () => {
		const byId = new Map(model.toolCalls.map((call) => [call.id, call]));
		expect(byId.get('t5')?.stepId).toBe('f1a');
		expect(model.steps.find((step) => step.id === 'f1a')?.toolCallIds).toContain('t5');
		expect(byId.get('t1')?.stepId).toBe('f2a'); // fallback: no closed step starts late enough
		expect(byId.get('t1')?.isMcp).toBe(false);
		expect(byId.get('t2')?.isMcp).toBe(true);
		expect(byId.get('t2')?.flags).toContain('clampedEnd');
		expect(byId.get('t2')?.endedAt).toBe(T + 350);
		expect(byId.get('t4')?.flags).toContain('futureEnd');
		expect(byId.get('t4')?.endedAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now());
		expect(byId.get('t3')?.trackerRefs).toEqual(['185']);
	});

	test('emits compaction and removed markers', () => {
		expect(model.markers).toContainEqual({ type: 'compaction', nodeId: 'root1', at: T + 850 });
		expect(model.markers).toContainEqual({ type: 'removed', nodeId: 'root1', at: null });
		expect(model.markers).toContainEqual({ type: 'removed', nodeId: 'child1', at: null });
	});

	test('collects root, child and grandchild edges exactly once', () => {
		const edges = model.edges;
		expect(edges.map((edge) => edge.id).sort()).toEqual(['d1', 'd2', 'd3', 'd4', 'd_orphan']);
		expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
		const byId = new Map(edges.map((edge) => [edge.id, edge]));
		expect(byId.get('d3')).toMatchObject({ childNodeId: null, status: 'error' });
		expect(byId.get('d3')?.flags).toContain('noChild');
		expect(byId.get('d2')?.parentNodeId).toBe('child1');
		expect(byId.get('d1')?.resultBytes).toBe('child result'.length);
		expect(byId.get('d1')?.trackerRefs).toContain('42');
		expect(byId.get('d2')?.trackerRefs).toContain('44');
	});

	test('t1 spans to the furthest child raw end (2500)', () => {
		expect(model.t1).toBe(T + 2500);
	});
});

describe('buildTurnModel — turn 2 (u2)', () => {
	const model = buildTurnModel('root1', 'u2')!;

	test('contains only the root and assistant messages parented to u2', () => {
		expect(model.nodes.map((node) => node.sessionId)).toEqual(['root1']);
		expect(model.edges).toEqual([]);
		expect(model.t0).toBe(T + 2000);
		expect(model.steps.map((step) => step.id)).toEqual(['f1c']);
		const root = model.nodes[0];
		expect(root.compactionCount).toBe(0);
		expect(root.usage).toEqual({
			input: 20,
			output: 10,
			reasoning: 5,
			cacheRead: 0,
			cacheWrite: 0,
			total: 35,
			cost: 0
		});
	});
});

describe('buildTurnModel — running nodes', () => {
	const model = buildTurnModel('runRoot', 'ru1')!;
	const root = model.nodes.find((node) => node.sessionId === 'runRoot');

	test('end=null marks the node and its tool running with endedAt null', () => {
		expect(root?.running).toBe(true);
		expect(root?.status).toBe('running');
		expect(root?.endedAt).toBeNull();
		expect(root?.openStep).toBe(true);
		const bash = model.toolCalls.find((call) => call.id === 'rt_bash');
		expect(bash).toMatchObject({ status: 'running', endedAt: null });
	});

	test('an open step carries the residual message usage (message - closed steps)', () => {
		const open = model.steps.find((step) => step.id === 'rs1');
		expect(open).toMatchObject({ open: true, endedAt: null });
		expect(open?.usage).toEqual({
			input: 20,
			output: 10,
			reasoning: 3,
			cacheRead: 0,
			cacheWrite: 0,
			total: 33,
			cost: 0
		});
	});

	test('a delegation edge with no end stays running', () => {
		expect(model.edges.find((edge) => edge.id === 'rt_run')).toMatchObject({
			running: true,
			endedAt: null,
			childNodeId: 'runChild'
		});
	});
});

describe('buildTurnModel — time clamps', () => {
	test('end < start is clamped to start and flagged', () => {
		const model = buildTurnModel('badRoot', 'u_bad')!;
		const node = model.nodes[0];
		expect(node.startedAt).toBe(T + 4000);
		expect(node.endedAt).toBe(T + 4000);
		expect(node.flags).toContain('clampedEnd');
		expect(node.running).toBe(false);
	});

	test('a future end is clamped to now and flagged', () => {
		const model = buildTurnModel('futureRoot', 'u_fut')!;
		const node = model.nodes[0];
		expect(node.flags).toContain('futureEnd');
		expect(node.endedAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now());
		expect(node.endedAt).not.toBe(null);
	});
});

describe('buildTurnModel — unknown ids', () => {
	test('returns null for an unknown root session', () => {
		expect(buildTurnModel('does-not-exist', 'u1')).toBeNull();
	});

	test('returns null when the trigger message is not a user message of the root', () => {
		expect(buildTurnModel('root1', 'a1')).toBeNull();
		expect(buildTurnModel('root1', 'nope')).toBeNull();
	});
});

describe('read-only guard', () => {
	test('the fixture connection is query_only and cannot write', () => {
		const db = getDb();
		expect(db.query('PRAGMA query_only').get()).toEqual({ query_only: 1 });
		expect(() => db.exec("INSERT INTO session (id) VALUES ('nope')")).toThrow(/readonly/i);
	});
});

/**
 * ADR §7.1 layering regression: SQL statements live only in
 * `lib/server/queries/**`. Route/service modules must go through the query
 * layer; `db.ts` keeps the connection PRAGMAs (not statements). Comments are
 * stripped so prose about SQL never trips the scan.
 */
describe('layering (ADR §7.1) — SQL lives only in queries/**', () => {
	const srcRoot = fileURLToPath(new URL('../../', import.meta.url));

	function walkTs(dir: string): string[] {
		const out: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...walkTs(full));
			else if (entry.name.endsWith('.ts')) out.push(full);
		}
		return out;
	}

	function stripComments(text: string): string {
		return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	}

	const SQL = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE)\b/i;

	test('no SQL statement outside lib/server/queries/**', () => {
		const offenders = walkTs(srcRoot)
			.filter((file) => !/\.(test|suite)\.ts$/.test(file))
			.filter((file) => !file.includes(`${join('lib', 'server', 'queries')}/`))
			.filter((file) => SQL.test(stripComments(readFileSync(file, 'utf8'))))
			.map((file) => file.slice(srcRoot.length));
		expect(offenders, 'SQL found outside the query layer').toEqual([]);
	});

	test('the query layer is where the SQL actually lives', () => {
		const queryFiles = walkTs(join(srcRoot, 'lib', 'server', 'queries'));
		expect(queryFiles.length).toBeGreaterThan(0);
		expect(
			queryFiles.some((file) => /\bSELECT\b/i.test(readFileSync(file, 'utf8')))
		).toBe(true);
	});
});
