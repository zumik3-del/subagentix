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

// Large fixed future timestamp, never flaky regardless of when the test runs.
const future = Number.MAX_SAFE_INTEGER;

/** Build a small opencode-shaped fixture: session_v2/session_message tables (V2). */
function buildFixture(path: string): void {
	const db = new Database(path);
	applyV2Schema(db);

	// --- sessions ---------------------------------------------------------
	addSessionV2(db, { id: 'root1', dir: '/repo/a', title: 'Root one', agent: 'build', created: T + 50, updated: T + 900, cost: 2, tokens: { input: 310, output: 125, reasoning: 40, cacheRead: 20, cacheWrite: 10 }, model: { id: 'gpt-5', providerID: 'openai' } });
	addSessionV2(db, { id: 'child1', parentId: 'root1', dir: '/repo/a', title: 'Child one', agent: 'developer', created: T + 500, updated: T + 2500, cost: 0.5, tokens: { input: 50, output: 20, reasoning: 10, cacheRead: 0, cacheWrite: 0 }, model: { id: 'gpt-5', providerID: 'openai' } });
	addSessionV2(db, { id: 'child2', parentId: 'root1', dir: '/repo/a', title: 'Child two', agent: null, created: T + 700, updated: T + 760, archived: T + 760, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, model: null });
	addSessionV2(db, { id: 'grandchild1', parentId: 'child1', dir: '/repo/a', title: 'Grandchild', agent: 'tester', created: T + 600, updated: T + 690, cost: 0.1, tokens: { input: 5, output: 3, reasoning: 1, cacheRead: 0, cacheWrite: 0 }, model: { id: 'gpt-mini', providerID: 'openai' } });
	addSessionV2(db, { id: 'root2', dir: '/repo/b', title: 'Root two', agent: null, created: T + 1500, updated: T + 1600, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, model: null });
	addSessionV2(db, { id: 'runRoot', dir: '/repo/a', title: 'Running root', agent: 'build', created: T + 3000, updated: T + 3055, cost: 0, tokens: { input: 30, output: 15, reasoning: 5, cacheRead: 0, cacheWrite: 0 }, model: { id: 'gpt-5', providerID: 'openai' } });
	addSessionV2(db, { id: 'runChild', parentId: 'runRoot', dir: '/repo/a', title: 'Running child', agent: 'developer', created: T + 3050, updated: T + 3055, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, model: null });
	addSessionV2(db, { id: 'badRoot', dir: '/repo/a', title: 'Bad span', agent: 'build', created: T + 4000, updated: T + 3900, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, model: null });
	addSessionV2(db, { id: 'futureRoot', dir: '/repo/a', title: 'Future span', agent: 'build', created: T + 5000, updated: future, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, model: null });
	addSessionV2(db, { id: 'cycA', dir: '/repo/c', title: 'Cycle A', agent: 'build', created: T + 6000, updated: T + 6000, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, model: null });
	addSessionV2(db, { id: 'cycB', parentId: 'cycA', dir: '/repo/c', title: 'Cycle B', agent: 'build', created: T + 6000, updated: T + 6000, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, model: null });
	addSessionV2(db, { id: 'cycC', parentId: 'cycB', dir: '/repo/c', title: 'Cycle C', agent: 'build', created: T + 6000, updated: T + 6000, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, model: null });
	// Close the loop: cycA -> cycC -> cycB -> cycA (must not loop the CTE).
	db.prepare('UPDATE session_v2 SET parent_id = ? WHERE id = ?').run('cycC', 'cycA');

	// --- root1 messages (two turns) --------------------------------------
	// seq ordering: u1=1, a1=2, a1b=3, u2=4, a2=5, cmp1=6
	addUserMessage(db, { id: 'u1', sessionId: 'root1', seq: 1, created: T + 100, text: 'prompt 1' });
	addAssistantMessage(db, {
		id: 'a1', sessionId: 'root1', seq: 2, created: T + 150, completed: T + 900,
		agent: 'build', model: { id: 'gpt-5', providerID: 'openai' },
		cost: 2, tokens: { input: 300, output: 120, reasoning: 40, cacheRead: 20, cacheWrite: 10 },
		finish: 'tool-calls',
		content: [
			toolItem('bash', { id: 't1', status: 'completed', input: { command: 'ls' }, text: 'file list', created: T + 200, ran: T + 200, completed: T + 300 }),
			toolItem('mcp_synaptomind_memory_recall', { id: 't2', status: 'error', input: {}, error: { type: 'error', message: 'boom' }, created: T + 350, ran: T + 350, completed: T + 340 }),
			toolItem('ziptask_claim_task', { id: 't3', status: 'completed', input: { task_id: 185 }, text: '{"id":185}', created: T + 380, ran: T + 380, completed: T + 390 }),
			toolItem('read', { id: 't4', status: 'completed', input: {}, text: 'x', created: T + 400, ran: T + 400, completed: future }),
			toolItem('write', { id: 't5', status: 'completed', input: {}, text: 'ok', created: T + 850, ran: T + 850, completed: T + 860 }),
			subagentItem({ id: 'd_orphan', childSessionId: 'child2', agent: 'reviewer', description: 'old', prompt: 'legacy', status: 'completed', created: T + 50, ran: T + 50, completed: T + 60 }),
			subagentItem({ id: 'd1', childSessionId: 'child1', agent: 'developer', description: 'build feature', prompt: 'Task #42 build it', status: 'completed', text: 'child result', created: T + 500, ran: T + 500, completed: T + 800 }),
			subagentItem({ id: 'd4', childSessionId: 'child2', agent: 'reviewer', description: 'review', prompt: 'Task #43 review', status: 'completed', text: 'done', created: T + 700, ran: T + 700, completed: T + 750 }),
			subagentItem({ id: 'd3', childSessionId: null, agent: 'broken', description: 'nope', prompt: 'no prompt', status: 'error', error: { type: 'error', message: 'spawn failed' }, created: T + 1500, ran: T + 1500, completed: T + 1600 }),
		],
	});
	addAssistantMessage(db, { id: 'a1b', sessionId: 'root1', seq: 3, created: T + 200, completed: T + 400, agent: 'build', model: { id: 'gpt-5', providerID: 'openai' }, cost: 0, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, finish: 'stop', content: [] });
	addUserMessage(db, { id: 'u2', sessionId: 'root1', seq: 4, created: T + 2000, text: 'prompt 2' });
	addAssistantMessage(db, { id: 'a2', sessionId: 'root1', seq: 5, created: T + 2010, completed: T + 2100, agent: 'build', model: { id: 'gpt-5', providerID: 'openai' }, cost: 0, tokens: { input: 20, output: 10, reasoning: 5, cacheRead: 0, cacheWrite: 0 }, finish: 'stop', content: [] });
	addCompactionMessage(db, { id: 'cmp1', sessionId: 'root1', seq: 6, created: T + 850 });

	// --- child1 / grandchild1 / runRoot / badRoot / futureRoot ------------
	addUserMessage(db, { id: 'cu1', sessionId: 'child1', seq: 1, created: T + 500, text: 'prompt' });
	addAssistantMessage(db, {
		id: 'ca1', sessionId: 'child1', seq: 2, created: T + 520, completed: T + 760,
		agent: 'developer', model: { id: 'gpt-5', providerID: 'openai' },
		cost: 0.5, tokens: { input: 50, output: 20, reasoning: 10, cacheRead: 0, cacheWrite: 0 },
		finish: 'stop',
		content: [
			subagentItem({ id: 'd2', childSessionId: 'grandchild1', agent: 'tester', description: 'tests', prompt: 'Task #44 test', status: 'completed', text: 'tested', created: T + 600, ran: T + 600, completed: T + 700 }),
		],
	});
	addCompactionMessage(db, { id: 'cmp2', sessionId: 'child1', seq: 3, created: T + 650 });
	addUserMessage(db, { id: 'gu1', sessionId: 'grandchild1', seq: 1, created: T + 600, text: 'prompt' });
	addAssistantMessage(db, { id: 'ga1', sessionId: 'grandchild1', seq: 2, created: T + 620, completed: T + 690, agent: 'tester', model: { id: 'gpt-mini', providerID: 'openai' }, cost: 0.1, tokens: { input: 5, output: 3, reasoning: 1, cacheRead: 0, cacheWrite: 0 }, finish: 'stop', content: [] });
	addUserMessage(db, { id: 'ru1', sessionId: 'runRoot', seq: 1, created: T + 3000, text: 'prompt' });
	addAssistantMessage(db, {
		id: 'ra1', sessionId: 'runRoot', seq: 2, created: T + 3000,
		agent: 'build', model: { id: 'gpt-5', providerID: 'openai' },
		cost: 0, tokens: { input: 30, output: 15, reasoning: 5, cacheRead: 0, cacheWrite: 0 },
		finish: 'tool-calls',
		content: [
			subagentItem({ id: 'rt_run', childSessionId: 'runChild', agent: 'developer', description: 'running', prompt: 'Task #50', status: 'running', created: T + 3050, ran: T + 3050 }),
			toolItem('bash', { id: 'rt_bash', status: 'running', input: {}, created: T + 3055, ran: T + 3055 }),
		],
	});
	addUserMessage(db, { id: 'u_bad', sessionId: 'badRoot', seq: 1, created: T + 4000, text: 'prompt' });
	addAssistantMessage(db, { id: 'a_bad', sessionId: 'badRoot', seq: 2, created: T + 4000, completed: T + 3900, agent: 'build', model: { id: 'gpt-5', providerID: 'openai' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, finish: 'stop', content: [] });
	addUserMessage(db, { id: 'u_fut', sessionId: 'futureRoot', seq: 1, created: T + 5000, text: 'prompt' });
	addAssistantMessage(db, { id: 'a_fut', sessionId: 'futureRoot', seq: 2, created: T + 5000, completed: future, agent: 'build', model: { id: 'gpt-5', providerID: 'openai' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, finish: 'stop', content: [] });

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
const { getMessages, getToolParts, getCompactionParts } = await import('./queries/messages');
const { buildTurnModel } = await import('./services/turn');
const {
	jsonEquals,
	jsonExtract,
	jsonIn,
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

	test('getDelegationEdges returns only subagent items, ordered by time', () => {
		const edges = getDelegationEdges('root1');
		// V2 synthesizes edge ids as `messageId#index`.
		expect(edges.map((edge) => edge.id).sort()).toEqual(['a1#5', 'a1#6', 'a1#7', 'a1#8']);
		const d1 = edges.find((edge) => edge.id === 'a1#6');
		expect(d1).toMatchObject({
			parentSessionId: null,
			childSessionId: 'child1',
			subagentType: 'developer',
			status: 'completed',
			startedAt: T + 500,
			endedAt: T + 800,
			resultBytes: 'child result'.length,
			description: 'build feature'
		});
		const d3 = edges.find((edge) => edge.id === 'a1#8');
		expect(d3?.childSessionId).toBeNull();
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

	test('getMessages classifies roles', () => {
		const allMessages = getMessages('root1');
		// V2 returns all message types; filter to user/assistant for the old test.
		const messages = allMessages.filter((m) => m.role === 'user' || m.role === 'assistant');
		expect(messages.map((message) => message.id)).toEqual(['u1', 'a1', 'a1b', 'u2', 'a2']);
		const users = messages.filter((message) => message.role === 'user').map((message) => message.id);
		expect(users).toEqual(['u1', 'u2']);
		expect(messages.find((message) => message.id === 'a1')?.usage).toEqual({
			input: 300,
			output: 120,
			reasoning: 40,
			cacheRead: 20,
			cacheWrite: 10
		});
	});

	test('getToolParts returns tool parts only, including delegations', () => {
		const names = getToolParts('root1').map((part) => part.name);
		// V2: 5 regular tools + 4 subagent delegations.
		expect(names).toEqual(['bash', 'mcp_synaptomind_memory_recall', 'ziptask_claim_task', 'read', 'write', 'subagent', 'subagent', 'subagent', 'subagent']);
	});

	test('getCompactionParts returns compaction markers only', () => {
		const parts = getCompactionParts('root1');
		// V2 synthesizes compaction id as `messageId#0`.
		expect(parts.map((part) => part.id)).toEqual(['cmp1#0']);
		expect(parts[0].type).toBe('compaction');
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
		// Turn 1 has a1 (300/120/40/20/10) + a1b (10/5/0/0/0) = 310/125/40/20/10.
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
		// 5 non-subagent tools + 4 subagent delegations; t2 failed.
		// Two assistant messages in turn 1 => 2 steps.
		expect(root).toMatchObject({ stepCount: 2, toolCallCount: 9, errorCount: 2, compactionCount: 1 });
		const rootSteps = model.steps.filter((step) => step.nodeId === 'root1');
		expect(rootSteps.map((step) => step.messageId)).toEqual(['a1', 'a1b']);
		expect(rootSteps.map((step) => step.id).sort()).toEqual(['a1', 'a1b']);
	});

	test('attributes tool calls to the owning message step and flags bad spans', () => {
		const byId = new Map(model.toolCalls.map((call) => [call.id, call]));
		// Tool call ids are synthesized as messageId#index.
		expect(byId.get('a1#4')?.stepId).toBe('a1'); // t5 is the 5th item (index 4)
		expect(model.steps.find((step) => step.id === 'a1')?.toolCallIds).toContain('a1#4');
		expect(byId.get('a1#0')?.isMcp).toBe(false); // t1 = bash
		expect(byId.get('a1#1')?.isMcp).toBe(true); // t2 = mcp_synaptomind_memory_recall
		expect(byId.get('a1#1')?.flags).toContain('clampedEnd');
		expect(byId.get('a1#1')?.endedAt).toBe(T + 350);
		expect(byId.get('a1#3')?.flags).toContain('futureEnd');
		expect(byId.get('a1#3')?.endedAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now());
		expect(byId.get('a1#2')?.trackerRefs).toEqual(['185']);
	});

	test('emits compaction markers (no removed markers in V2)', () => {
		expect(model.markers).toContainEqual({ type: 'compaction', nodeId: 'root1', at: T + 850 });
		// V2 has no removed markers.
		expect(model.markers.filter((m) => m.type === 'removed').length).toBe(0);
	});

	test('collects root, child and grandchild edges exactly once', () => {
		const edges = model.edges;
		// Edge ids are synthesized as messageId#index.
		expect(edges.map((edge) => edge.id).sort()).toEqual(['a1#5', 'a1#6', 'a1#7', 'a1#8', 'ca1#0']);
		expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
		const byId = new Map(edges.map((edge) => [edge.id, edge]));
		const d3 = byId.get('a1#8');
		expect(d3).toMatchObject({ childNodeId: null, status: 'error' });
		expect(d3?.flags).toContain('noChild');
		const d2 = byId.get('ca1#0');
		expect(d2?.parentNodeId).toBe('child1');
		const d1 = byId.get('a1#6');
		expect(d1?.resultBytes).toBe('child result'.length);
		expect(d1?.trackerRefs).toContain('42');
		expect(d2?.trackerRefs).toContain('44');
	});

	test('t1 spans to the furthest child raw end (future tool end)', () => {
		// In V2, rawEnd includes content-item ends (not just message/session ends),
		// so t4's future-completed inflates root1's rawEnd beyond child1's updatedAt.
		expect(model.t1).toBe(future);
	});
});

describe('buildTurnModel — turn 2 (u2)', () => {
	const model = buildTurnModel('root1', 'u2')!;

	test('contains only the root and assistant messages in the u2 window', () => {
		expect(model.nodes.map((node) => node.sessionId)).toEqual(['root1']);
		expect(model.edges).toEqual([]);
		expect(model.t0).toBe(T + 2000);
		expect(model.steps.map((step) => step.id)).toEqual(['a2']);
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
		const bash = model.toolCalls.find((call) => call.id === 'ra1#1');
		expect(bash).toMatchObject({ status: 'running', endedAt: null });
	});

	test('an open step carries the residual message usage', () => {
		// In V2, the step IS the message. The open step is ra1 with no completed.
		const open = model.steps.find((step) => step.id === 'ra1');
		expect(open).toMatchObject({ open: true, endedAt: null });
		expect(open?.usage).toEqual({
			input: 30,
			output: 15,
			reasoning: 5,
			cacheRead: 0,
			cacheWrite: 0,
			total: 50,
			cost: 0
		});
	});

	test('a delegation edge with no end stays running', () => {
		const edge = model.edges.find((edge) => edge.id === 'ra1#0');
		expect(edge).toMatchObject({
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
		expect(() => db.exec("INSERT INTO session_v2 (id) VALUES ('nope')")).toThrow(/readonly/i);
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
			// Exclude the shared V2 fixture which intentionally contains DDL.
			.filter((file) => !file.includes('test-fixtures/opencode-v2.ts'))
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
