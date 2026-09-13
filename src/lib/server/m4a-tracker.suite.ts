/**
 * M4a tracker-reference resolver suite (task #199, feature #198).
 *
 * This file intentionally has NO `.test` suffix: `health.test.ts` installs a
 * process-wide `mock.module('$lib/server/db', ...)` that bun cannot undo, so any
 * suite that exercises the real DB module must run in an isolated child
 * `bun test` process. The wrapper `m4a-tracker.test.ts` spawns it and asserts
 * `0 fail` (pattern from `data-layer.suite.ts` / `api.suite.ts`).
 *
 * It builds a throwaway fixture that exercises every `extractTrackerRefs`
 * branch through the real `buildTurnModel` service:
 *   - `ziptask_*` input `task_id` / `id`, output `id`, blank input, no id,
 *     absent/unparseable output;
 *   - `task` prompt / description / both, and the #198 deviation (a non-`task`
 *     call whose text contains `Task #N` is NOT parsed);
 *   - dedup across both inference paths and node vs turn aggregation.
 *
 * The live opencode DB is never opened or written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T = 1_700_000_000_000;

const SCHEMA = `
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
`;

const MODEL = JSON.stringify({ id: 'gpt-5', providerID: 'openai' });

function buildFixture(path: string): void {
	const db = new Database(path);
	db.exec(SCHEMA);

	const session = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	session.run('root1', null, '/repo/a', 'Tracker root', 'build', T + 50, T + 1_900, null, 0, 0, 0, 0, 0, 0, MODEL);
	session.run('child1', 'root1', '/repo/a', 'Tracker child', 'developer', T + 200, T + 500, null, 0, 0, 0, 0, 0, 0, MODEL);

	const message = db.prepare(
		'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
	);
	message.run('u1', 'root1', T + 100, T + 100, JSON.stringify({ role: 'user', time: { created: T + 100 } }));
	message.run(
		'a1',
		'root1',
		T + 110,
		T + 1_900,
		JSON.stringify({
			role: 'assistant',
			parentID: 'u1',
			agent: 'build',
			modelID: 'gpt-5',
			providerID: 'openai',
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0 },
			time: { created: T + 110, completed: T + 1_900 }
		})
	);
	message.run('cu1', 'child1', T + 200, T + 200, JSON.stringify({ role: 'user', time: { created: T + 200 } }));
	message.run(
		'ca1',
		'child1',
		T + 210,
		T + 500,
		JSON.stringify({
			role: 'assistant',
			parentID: 'cu1',
			agent: 'developer',
			modelID: 'gpt-5',
			providerID: 'openai',
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0 },
			time: { created: T + 210, completed: T + 500 }
		})
	);

	const part = db.prepare(
		'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
	);
	/** One `part.data` tool row at `created`; `state` is the opencode tool state. */
	const tool = (
		id: string,
		messageId: string,
		sessionId: string,
		created: number,
		name: string,
		state: Record<string, unknown>
	) => part.run(id, messageId, sessionId, created, created, JSON.stringify({ type: 'tool', tool: name, callID: `call-${id}`, state }));

	const done = (start: number, end: number, extra: Record<string, unknown> = {}) => ({
		status: 'completed',
		time: { start, end },
		...extra
	});

	// --- ziptask_* input/output resolution --------------------------------
	// input.task_id wins.
	tool('zt_input_task_id', 'a1', 'root1', T + 120, 'ziptask_claim_task', done(T + 120, T + 130, { input: { task_id: 179 }, output: '{"id":179}' }));
	// input.id wins over a conflicting output.id.
	tool('zt_input_id', 'a1', 'root1', T + 135, 'ziptask_get_task', done(T + 135, T + 145, { input: { id: 200 }, output: '{"id":999}' }));
	// No input id -> output.id.
	tool('zt_output_only', 'a1', 'root1', T + 150, 'ziptask_list_tasks', done(T + 150, T + 160, { input: {}, output: '{"id":201}' }));
	// Blank input id falls through to output.id.
	tool('zt_blank_input', 'a1', 'root1', T + 165, 'ziptask_claim_task', done(T + 165, T + 175, { input: { task_id: '' }, output: '{"id":202}' }));
	// No id anywhere.
	tool('zt_no_id', 'a1', 'root1', T + 180, 'ziptask_noop', done(T + 180, T + 190, { input: {}, output: '{"other":1}' }));
	tool('zt_absent_output', 'a1', 'root1', T + 195, 'ziptask_noop', done(T + 195, T + 205, { input: {} }));
	tool('zt_unparseable_output', 'a1', 'root1', T + 210, 'ziptask_bad', done(T + 210, T + 220, { input: {}, output: 'not json' }));

	// --- `task` prompt / description inference ----------------------------
	// prompt only; this is the earliest edge to child1, so it owns the child node.
	tool('task_prompt', 'a1', 'root1', T + 225, 'task', done(T + 225, T + 260, { metadata: { parentSessionId: 'root1', sessionId: 'child1' }, input: { subagent_type: 'developer', prompt: 'Please do Task #179 now' }, output: 'ok' }));
	// description only.
	tool('task_desc', 'a1', 'root1', T + 270, 'task', done(T + 270, T + 300, { metadata: { parentSessionId: 'root1' }, input: { subagent_type: 'reviewer', description: 'Fixes Task #203' }, output: '' }));
	// both fields, repeated and multiple refs.
	tool('task_both', 'a1', 'root1', T + 310, 'task', done(T + 310, T + 340, { metadata: { parentSessionId: 'root1' }, input: { subagent_type: 'tester', prompt: 'Task #204 and Task #205', description: 'Task #204 again' }, output: 'ok' }));
	// a task call with no Task #N text at all.
	tool('task_no_ref', 'a1', 'root1', T + 350, 'task', done(T + 350, T + 380, { metadata: { parentSessionId: 'root1' }, input: { subagent_type: 'x', description: 'no ref here' }, output: 'ok' }));
	// #198 deviation: only `task` calls parse Task #N, never other tools.
	tool('bash_with_task_text', 'a1', 'root1', T + 390, 'bash', done(T + 390, T + 400, { input: { command: 'echo Task #999' }, output: 'Task #998' }));
	tool('zt_search_prompt', 'a1', 'root1', T + 410, 'ziptask_search', done(T + 410, T + 420, { input: { prompt: 'Task #997' }, output: 'not json' }));
	// dedup across the ziptask and task paths (#203 already seen in task_desc).
	tool('zt_ref_shared', 'a1', 'root1', T + 430, 'ziptask_claim_task', done(T + 430, T + 440, { input: { task_id: 203 }, output: '{"id":203}' }));

	// --- child node owns its own ref ---------------------------------------
	tool('child_zt', 'ca1', 'child1', T + 250, 'ziptask_get_task', done(T + 250, T + 260, { input: { id: 300 }, output: '{"id":300}' }));

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-m4a-tracker-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

const { buildTurnModel } = await import('./services/turn');
const { mergeTrackerRefs } = await import('../model/tracker');
/** Absolute path so the bracketed `[id]` route segment and `.ts` survive Vite. */
const detailPageSpec = new URL('../../routes/sessions/[id]/+page.server.ts', import.meta.url).pathname;
const { load: loadDetailPage } = (await import(detailPageSpec)) as {
	load: (event: { params: { id: string }; url: URL }) => {
		ziptaskEnabled: boolean;
		ziptaskBaseUrl: string | null;
		gantt: { trackerRefs?: string[] } | null;
	};
};

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

const model = buildTurnModel('root1', 'u1')!;
const byCall = new Map(model.toolCalls.map((call) => [call.id, call]));
const byEdge = new Map(model.edges.map((edge) => [edge.id, edge]));

describe('ziptask_* resolution (input then output)', () => {
	test('reads state.input.task_id first', () => {
		expect(byCall.get('zt_input_task_id')?.trackerRefs).toEqual(['179']);
	});

	test('falls back from task_id to state.input.id', () => {
		expect(byCall.get('zt_input_id')?.trackerRefs).toEqual(['200']);
	});

	test('reads only state.output.id when the input carries no id', () => {
		expect(byCall.get('zt_output_only')?.trackerRefs).toEqual(['201']);
	});

	test('a blank input id falls through to the output id', () => {
		expect(byCall.get('zt_blank_input')?.trackerRefs).toEqual(['202']);
	});

	test('no id in input or output yields no ref', () => {
		expect(byCall.get('zt_no_id')?.trackerRefs).toEqual([]);
		expect(byCall.get('zt_absent_output')?.trackerRefs).toEqual([]);
	});

	test('an unparseable output is ignored instead of throwing', () => {
		expect(byCall.get('zt_unparseable_output')?.trackerRefs).toEqual([]);
	});
});

describe('task prompt / description resolution', () => {
	test('parses Task #N from state.input.prompt', () => {
		expect(byCall.get('task_prompt')?.trackerRefs).toEqual(['179']);
	});

	test('parses Task #N from state.input.description', () => {
		expect(byCall.get('task_desc')?.trackerRefs).toEqual(['203']);
	});

	test('parses both fields, deduplicating and keeping first-seen order', () => {
		expect(byCall.get('task_both')?.trackerRefs).toEqual(['204', '205']);
	});

	test('a task call without Task #N text yields no ref', () => {
		expect(byCall.get('task_no_ref')?.trackerRefs).toEqual([]);
	});
});

describe('#198 deviation — only `task` calls parse Task #N', () => {
	test('a non-task tool with Task #N input/output is NOT parsed', () => {
		expect(byCall.get('bash_with_task_text')?.trackerRefs).toEqual([]);
	});

	test('a ziptask_* call with a Task #N prompt but no id is NOT parsed', () => {
		expect(byCall.get('zt_search_prompt')?.trackerRefs).toEqual([]);
	});

	test('delegation edges still parse the task prompt/description', () => {
		expect(byEdge.get('task_prompt')?.trackerRefs).toEqual(['179']);
		expect(byEdge.get('task_desc')?.trackerRefs).toEqual(['203']);
		expect(byEdge.get('task_both')?.trackerRefs).toEqual(['204', '205']);
		expect(byEdge.get('task_no_ref')?.trackerRefs).toEqual([]);
	});
});

describe('node vs turn aggregation (M4a DTO fields)', () => {
	test('the root node unifies its tool calls and spawned `task` edges', () => {
		const root = model.nodes.find((node) => node.sessionId === 'root1');
		expect(root?.trackerRefs).toEqual(['179', '200', '201', '202', '203', '204', '205']);
	});

	test('the child node only owns refs of its own session', () => {
		const child = model.nodes.find((node) => node.sessionId === 'child1');
		expect(child?.trackerRefs).toEqual(['300']);
	});

	test('turnTrackerRefs equals the union of node, call and edge refs', () => {
		expect(model.trackerRefs).toEqual(mergeTrackerRefs(
			model.nodes.flatMap((node) => node.trackerRefs ?? []),
			model.toolCalls.flatMap((call) => call.trackerRefs),
			model.edges.flatMap((edge) => edge.trackerRefs)
		));
	});

	test('the turn refs union every path, deduplicated in first-seen order', () => {
		expect(model.trackerRefs).toEqual(['179', '200', '201', '202', '203', '204', '205', '300']);
		// `179` is inferred twice (ziptask input + task prompt) but surfaces once.
		expect(model.trackerRefs?.filter((ref) => ref === '179')).toEqual(['179']);
		expect(model.trackerRefs?.filter((ref) => ref === '203')).toEqual(['203']);
	});

	test('exposes the refs as strings on both node and model DTOs', () => {
		expect(model.nodes.every((node) => Array.isArray(node.trackerRefs))).toBe(true);
		expect(Array.isArray(model.trackerRefs)).toBe(true);
	});
});

describe('session page loader wiring (ZIPTASK_BASE_URL)', () => {
	test('surfaces the configured base to the Gantt prop and null when unset', () => {
		const previous = process.env.ZIPTASK_BASE_URL;
		const event = () => ({
			params: { id: 'root1' },
			url: new URL('http://localhost/sessions/root1?turn=u1')
		});
		const previousEnabled = process.env.ZIPTASK_ENABLED;
		try {
			process.env.ZIPTASK_BASE_URL = 'https://zt.example/';
			delete process.env.ZIPTASK_ENABLED;
			const withBase = loadDetailPage(event());
			expect(withBase.ziptaskEnabled).toBe(true);
			expect(withBase.ziptaskBaseUrl).toBe('https://zt.example/');
			// The same turn refs the service computed reach the client DTO.
			expect(withBase.gantt?.trackerRefs).toEqual(model.trackerRefs);

			// The feature toggle hides the integration even with a base URL set.
			process.env.ZIPTASK_ENABLED = '0';
			const disabled = loadDetailPage(event());
			expect(disabled.ziptaskEnabled).toBe(false);
			expect(disabled.ziptaskBaseUrl).toBeNull();

			delete process.env.ZIPTASK_ENABLED;
			delete process.env.ZIPTASK_BASE_URL;
			const unset = loadDetailPage(event());
			expect(unset.ziptaskEnabled).toBe(false);
			expect(unset.ziptaskBaseUrl).toBeNull();
		} finally {
			if (previous === undefined) delete process.env.ZIPTASK_BASE_URL;
			else process.env.ZIPTASK_BASE_URL = previous;
			if (previousEnabled === undefined) delete process.env.ZIPTASK_ENABLED;
			else process.env.ZIPTASK_ENABLED = previousEnabled;
		}
	});
});
