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
 *   - `subagent` (V2 delegation) prompt / description / both, and the #198
 *     deviation (a non-`subagent` tool whose text contains `Task #N` is NOT
 *     parsed);
 *   - dedup across both inference paths and node vs turn aggregation.
 *
 * The live opencode DB is never opened or written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	applyV2Schema,
	addSessionV2,
	addUserMessage,
	addAssistantMessage,
	toolItem,
	subagentItem,
	T,
} from './test-fixtures/opencode-v2';

const MODEL = { id: 'gpt-5', providerID: 'openai' };

function buildFixture(path: string): void {
	const db = new Database(path);
	applyV2Schema(db);

	// --- sessions ---------------------------------------------------------
	addSessionV2(db, { id: 'root1', dir: '/repo/a', title: 'Tracker root', agent: 'build', created: T + 50, updated: T + 1_900, cost: 0, tokens: { input: 0, output: 0, reasoning: 0 }, model: MODEL });
	addSessionV2(db, { id: 'child1', parentId: 'root1', dir: '/repo/a', title: 'Tracker child', agent: 'developer', created: T + 200, updated: T + 500, cost: 0, tokens: { input: 0, output: 0, reasoning: 0 }, model: MODEL });

	// --- root1 messages ---------------------------------------------------
	addUserMessage(db, { id: 'u1', sessionId: 'root1', seq: 1, created: T + 100, text: 'prompt' });
	addAssistantMessage(db, {
		id: 'a1', sessionId: 'root1', seq: 2, created: T + 110, completed: T + 1_900,
		agent: 'build', model: MODEL,
		cost: 0, tokens: { input: 0, output: 0, reasoning: 0 },
		finish: 'tool-calls',
		content: [
			// ziptask_* input/output resolution (indices 0-6)
			toolItem('ziptask_claim_task', { id: 'zt_input_task_id', status: 'completed', input: { task_id: 179 }, text: '{"id":179}', created: T + 120, ran: T + 120, completed: T + 130 }),
			toolItem('ziptask_get_task', { id: 'zt_input_id', status: 'completed', input: { id: 200 }, text: '{"id":999}', created: T + 135, ran: T + 135, completed: T + 145 }),
			toolItem('ziptask_list_tasks', { id: 'zt_output_only', status: 'completed', input: {}, text: '{"id":201}', created: T + 150, ran: T + 150, completed: T + 160 }),
			toolItem('ziptask_claim_task', { id: 'zt_blank_input', status: 'completed', input: { task_id: '' }, text: '{"id":202}', created: T + 165, ran: T + 165, completed: T + 175 }),
			toolItem('ziptask_noop', { id: 'zt_no_id', status: 'completed', input: {}, text: '{"other":1}', created: T + 180, ran: T + 180, completed: T + 190 }),
			toolItem('ziptask_noop', { id: 'zt_absent_output', status: 'completed', input: {}, created: T + 195, ran: T + 195, completed: T + 205 }),
			toolItem('ziptask_bad', { id: 'zt_unparseable_output', status: 'completed', input: {}, text: 'not json', created: T + 210, ran: T + 210, completed: T + 220 }),
			// subagent (V2 delegation) prompt/description inference (indices 7-10)
			subagentItem({ id: 'task_prompt', childSessionId: 'child1', agent: 'developer', description: 'build', prompt: 'Please do Task #179 now', status: 'completed', text: 'ok', created: T + 225, ran: T + 225, completed: T + 260 }),
			subagentItem({ id: 'task_desc', childSessionId: null, agent: 'reviewer', description: 'Fixes Task #203', prompt: '', status: 'completed', text: '', created: T + 270, ran: T + 270, completed: T + 300 }),
			subagentItem({ id: 'task_both', childSessionId: null, agent: 'tester', description: 'Task #204 again', prompt: 'Task #204 and Task #205', status: 'completed', text: 'ok', created: T + 310, ran: T + 310, completed: T + 340 }),
			subagentItem({ id: 'task_no_ref', childSessionId: null, agent: 'x', description: 'no ref here', prompt: '', status: 'completed', text: 'ok', created: T + 350, ran: T + 350, completed: T + 380 }),
			// #198 deviation: only `subagent` calls parse Task #N (indices 11-12)
			toolItem('bash', { id: 'bash_with_task_text', status: 'completed', input: { command: 'echo Task #999' }, text: 'Task #998', created: T + 390, ran: T + 390, completed: T + 400 }),
			toolItem('ziptask_search', { id: 'zt_search_prompt', status: 'completed', input: { prompt: 'Task #997' }, text: 'not json', created: T + 410, ran: T + 410, completed: T + 420 }),
			// dedup: ziptask_claim_task with task_id 203 (same as task_desc) (index 13)
			toolItem('ziptask_claim_task', { id: 'zt_ref_shared', status: 'completed', input: { task_id: 203 }, text: '{"id":203}', created: T + 430, ran: T + 430, completed: T + 440 }),
		],
	});

	// --- child1 messages --------------------------------------------------
	addUserMessage(db, { id: 'cu1', sessionId: 'child1', seq: 1, created: T + 200, text: 'prompt' });
	addAssistantMessage(db, {
		id: 'ca1', sessionId: 'child1', seq: 2, created: T + 210, completed: T + 500,
		agent: 'developer', model: MODEL,
		cost: 0, tokens: { input: 0, output: 0, reasoning: 0 },
		finish: 'tool-calls',
		content: [
			toolItem('ziptask_get_task', { id: 'child_zt', status: 'completed', input: { id: 300 }, text: '{"id":300}', created: T + 250, ran: T + 250, completed: T + 260 }),
		],
	});

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
	load: (event: { params: { id: string }; url: URL }) => Promise<{
		ziptaskEnabled: boolean;
		ziptaskBaseUrl: string | null;
		// The Gantt is streamed (task #385): the model arrives behind a promise.
		gantt: Promise<{ trackerRefs?: string[] }> | null;
	}>;
};

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// V2 synthesizes tool call / edge ids as `messageId#index`.
const model = buildTurnModel('root1', 'u1')!;
const byCall = new Map(model.toolCalls.map((call) => [call.id, call]));
const byEdge = new Map(model.edges.map((edge) => [edge.id, edge]));

describe('ziptask_* resolution (input then output)', () => {
	test('reads state.input.task_id first', () => {
		expect(byCall.get('a1#0')?.trackerRefs).toEqual(['179']);
	});

	test('falls back from task_id to state.input.id', () => {
		expect(byCall.get('a1#1')?.trackerRefs).toEqual(['200']);
	});

	test('reads only state.output.id when the input carries no id', () => {
		expect(byCall.get('a1#2')?.trackerRefs).toEqual(['201']);
	});

	test('a blank input id falls through to the output id', () => {
		expect(byCall.get('a1#3')?.trackerRefs).toEqual(['202']);
	});

	test('no id in input or output yields no ref', () => {
		expect(byCall.get('a1#4')?.trackerRefs).toEqual([]);
		expect(byCall.get('a1#5')?.trackerRefs).toEqual([]);
	});

	test('an unparseable output is ignored instead of throwing', () => {
		expect(byCall.get('a1#6')?.trackerRefs).toEqual([]);
	});
});

describe('subagent prompt / description resolution', () => {
	test('parses Task #N from state.input.prompt', () => {
		expect(byEdge.get('a1#7')?.trackerRefs).toEqual(['179']);
	});

	test('parses Task #N from state.input.description', () => {
		expect(byEdge.get('a1#8')?.trackerRefs).toEqual(['203']);
	});

	test('parses both fields, deduplicating and keeping first-seen order', () => {
		expect(byEdge.get('a1#9')?.trackerRefs).toEqual(['204', '205']);
	});

	test('a subagent call without Task #N text yields no ref', () => {
		expect(byEdge.get('a1#10')?.trackerRefs).toEqual([]);
	});
});

describe('#198 deviation — only `subagent` calls parse Task #N', () => {
	test('a non-subagent tool with Task #N input/output is NOT parsed', () => {
		expect(byCall.get('a1#11')?.trackerRefs).toEqual([]);
	});

	test('a ziptask_* call with a Task #N prompt but no id is NOT parsed', () => {
		expect(byCall.get('a1#12')?.trackerRefs).toEqual([]);
	});

	test('delegation edges still parse the subagent prompt/description', () => {
		expect(byEdge.get('a1#7')?.trackerRefs).toEqual(['179']);
		expect(byEdge.get('a1#8')?.trackerRefs).toEqual(['203']);
		expect(byEdge.get('a1#9')?.trackerRefs).toEqual(['204', '205']);
		expect(byEdge.get('a1#10')?.trackerRefs).toEqual([]);
	});
});

describe('node vs turn aggregation (M4a DTO fields)', () => {
	test('the root node unifies its tool calls and spawned `subagent` edges', () => {
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
		// `179` is inferred twice (ziptask input + subagent prompt) but surfaces once.
		expect(model.trackerRefs?.filter((ref) => ref === '179')).toEqual(['179']);
		expect(model.trackerRefs?.filter((ref) => ref === '203')).toEqual(['203']);
	});

	test('exposes the refs as strings on both node and model DTOs', () => {
		expect(model.nodes.every((node) => Array.isArray(node.trackerRefs))).toBe(true);
		expect(Array.isArray(model.trackerRefs)).toBe(true);
	});
});

describe('session page loader wiring (ZIPTASK_BASE_URL)', () => {
	test('surfaces the configured base to the Gantt prop and null when unset', async () => {
		const previous = process.env.ZIPTASK_BASE_URL;
		const event = () => ({
			params: { id: 'root1' },
			url: new URL('http://localhost/sessions/root1?turn=u1')
		});
		const previousEnabled = process.env.ZIPTASK_ENABLED;
		try {
			process.env.ZIPTASK_BASE_URL = 'https://zt.example/';
			delete process.env.ZIPTASK_ENABLED;
			const withBase = await loadDetailPage(event());
			expect(withBase.ziptaskEnabled).toBe(true);
			expect(withBase.ziptaskBaseUrl).toBe('https://zt.example/');
			// The same turn refs the service computed reach the client DTO.
			const gantt = await withBase.gantt;
			expect(gantt?.trackerRefs).toEqual(model.trackerRefs);

			// The feature toggle hides the integration even with a base URL set.
			process.env.ZIPTASK_ENABLED = '0';
			const disabled = await loadDetailPage(event());
			expect(disabled.ziptaskEnabled).toBe(false);
			expect(disabled.ziptaskBaseUrl).toBeNull();

			delete process.env.ZIPTASK_ENABLED;
			delete process.env.ZIPTASK_BASE_URL;
			const unset = await loadDetailPage(event());
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
