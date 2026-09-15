import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	mergeTrackerRefs,
	nodeTrackerRefs,
	normaliseTaskDetail,
	turnTrackerRefs
} from './tracker';
import type { Edge, GanttModel, Node, ToolCall, Usage } from './types';

/**
 * Unit tests for the pure inferred tracker-reference helpers (task #199 / M4a,
 * feature #198).
 *
 * `tracker.ts` is imported by the client-side `Gantt` component and by the
 * server-side turn service, so it must stay deterministic, DOM-free and free of
 * `$lib/server` imports. These tests pin the merge/collapse contracts and the
 * node/turn aggregation the rendered chips rely on.
 */

const usage = (): Usage => ({
	input: 0,
	output: 0,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	cost: 0
});

function makeNode(overrides: Partial<Node> & { sessionId: string }): Node {
	return {
		parentSessionId: null,
		agent: 'build',
		kind: 'orchestrator',
		modelId: 'gpt-5',
		providerId: 'openai',
		depth: 0,
		directory: '/repo/a',
		status: 'completed',
		startedAt: 1_000,
		endedAt: 2_000,
		running: false,
		flags: [],
		usage: usage(),
		stepCount: 0,
		toolCallCount: 0,
		errorCount: 0,
		compactionCount: 0,
		openStep: false,
		...overrides
	};
}

function makeTool(overrides: Partial<ToolCall> & { id: string; nodeId: string }): ToolCall {
	return {
		stepId: null,
		callId: 'c',
		name: 'bash',
		status: 'completed',
		error: null,
		startedAt: 1_000,
		endedAt: 1_100,
		flags: [],
		input: null,
		output: null,
		isMcp: false,
		isDelegation: false,
		trackerRefs: [],
		...overrides
	};
}

function makeEdge(overrides: Partial<Edge> & { id: string; parentNodeId: string }): Edge {
	return {
		childNodeId: null,
		subagentType: null,
		status: 'completed',
		error: null,
		startedAt: 1_000,
		endedAt: 1_100,
		running: false,
		flags: [],
		resultBytes: 0,
		description: null,
		trackerRefs: [],
		...overrides
	};
}

function makeModel(overrides: Partial<GanttModel> = {}): GanttModel {
	return {
		turnId: 'root_u1',
		rootSessionId: 'root',
		agent: 'build',
		t0: 0,
		t1: 10_000,
		nodes: [],
		edges: [],
		steps: [],
		toolCalls: [],
		markers: [],
		...overrides
	};
}

describe('mergeTrackerRefs()', () => {
	test('deduplicates while preserving first-seen order', () => {
		expect(mergeTrackerRefs(['b', 'a', 'b', 'c'], ['a', 'd'])).toEqual(['b', 'a', 'c', 'd']);
	});

	test('keeps the order across multiple lists (list 0 first)', () => {
		expect(mergeTrackerRefs(['1', '2'], ['3'], ['2', '4'])).toEqual(['1', '2', '3', '4']);
	});

	test('returns an empty list for no arguments or all-empty lists', () => {
		expect(mergeTrackerRefs()).toEqual([]);
		expect(mergeTrackerRefs([], [], [])).toEqual([]);
	});

	test('drops empty-string refs but keeps whitespace/other refs verbatim', () => {
		expect(mergeTrackerRefs(['', 'a', ''], ['a', ' '])).toEqual(['a', ' ']);
	});

	test('does not mutate its inputs', () => {
		const first = ['x', 'y'];
		const second = ['y', 'z'];
		mergeTrackerRefs(first, second);
		expect(first).toEqual(['x', 'y']);
		expect(second).toEqual(['y', 'z']);
	});
});

describe('nodeTrackerRefs()', () => {
	const rootTool = (refs: string[]) => makeTool({ id: `t${refs.join('')}`, nodeId: 'root', trackerRefs: refs });
	const rootEdge = (refs: string[]) => makeEdge({ id: `e${refs.join('')}`, parentNodeId: 'root', trackerRefs: refs });

	test('uses a populated node.trackerRefs verbatim (deduped)', () => {
		const node = makeNode({ sessionId: 'root', trackerRefs: ['b', 'a', 'b'] });
		const refs = nodeTrackerRefs(node, [rootTool(['t-only'])], [rootEdge(['e-only'])]);
		expect(refs).toEqual(['b', 'a']);
	});

	test('falls back to tool calls + edges when trackerRefs is absent or empty', () => {
		for (const trackerRefs of [undefined, []]) {
			const node = makeNode({ sessionId: 'root', ...(trackerRefs ? { trackerRefs } : {}) });
			expect(nodeTrackerRefs(node, [rootTool(['r1'])], [rootEdge(['e1'])])).toEqual(['r1', 'e1']);
		}
	});

	test('deduplicates across tool calls and edges in first-seen order', () => {
		const refs = nodeTrackerRefs(
			makeNode({ sessionId: 'root' }),
			[rootTool(['a', 'b']), rootTool(['b', 'c'])],
			[rootEdge(['c', 'a']), rootEdge(['d'])]
		);
		expect(refs).toEqual(['a', 'b', 'c', 'd']);
	});

	test('only counts tool calls and edges owned by this node', () => {
		const node = makeNode({ sessionId: 'root' });
		const toolCalls = [
			makeTool({ id: 'own', nodeId: 'root', trackerRefs: ['own'] }),
			makeTool({ id: 'other', nodeId: 'child', trackerRefs: ['other'] })
		];
		const edges = [
			makeEdge({ id: 'own-edge', parentNodeId: 'root', trackerRefs: ['own-edge'] }),
			makeEdge({ id: 'other-edge', parentNodeId: 'child', trackerRefs: ['other-edge'] })
		];
		expect(nodeTrackerRefs(node, toolCalls, edges)).toEqual(['own', 'own-edge']);
	});

	test('returns an empty list when the node owns nothing', () => {
		expect(nodeTrackerRefs(makeNode({ sessionId: 'root' }), [], [])).toEqual([]);
	});
});

describe('turnTrackerRefs()', () => {
	test('unions node, tool-call and edge refs, deduplicated in first-seen order', () => {
		const model = makeModel({
			nodes: [
				makeNode({ sessionId: 'root', trackerRefs: ['a', 'b'] }),
				makeNode({ sessionId: 'child', trackerRefs: ['c', 'a'] })
			],
			toolCalls: [
				makeTool({ id: 't1', nodeId: 'root', trackerRefs: ['b', 'd'] }),
				makeTool({ id: 't2', nodeId: 'child', trackerRefs: ['e'] })
			],
			edges: [makeEdge({ id: 'e1', parentNodeId: 'root', trackerRefs: ['d', 'f'] })]
		});
		expect(turnTrackerRefs(model)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
	});

	test('treats nodes without trackerRefs as empty', () => {
		const model = makeModel({
			nodes: [makeNode({ sessionId: 'root' })],
			toolCalls: [makeTool({ id: 't1', nodeId: 'root', trackerRefs: ['7'] })]
		});
		expect(turnTrackerRefs(model)).toEqual(['7']);
	});

	test('returns an empty list for a turn with no refs', () => {
		expect(turnTrackerRefs(makeModel())).toEqual([]);
	});
});

describe('normaliseTaskDetail()', () => {
	const rawTask = (overrides: Record<string, unknown> = {}) => ({
		id: 185,
		title: 'Ship the modal',
		description: 'Body text',
		status: 'done',
		priority: 'p1',
		assignee: 'developer',
		reporter: 'orchestrator',
		attempts: 1,
		max_attempts: 3,
		created_at: '2026-09-13T05:36:28.320Z',
		updated_at: '2026-09-13T06:14:23.159Z',
		completed_at: '2026-09-13T06:14:23.159Z',
		is_epic: 0,
		epic_id: null,
		...overrides
	});

	test('normalises a full payload and preserves comment order', () => {
		const detail = normaliseTaskDetail({
			task: rawTask(),
			blocked_by: [],
			comments: [
				{ id: 1, agent: 'system', content: 'first', type: 'comment', created_at: 'a' },
				{ id: 2, agent: 'orchestrator', content: 'done', type: 'resolution', created_at: 'b' }
			]
		});
		expect(detail).not.toBeNull();
		expect(detail?.task).toEqual({
			id: 185,
			title: 'Ship the modal',
			description: 'Body text',
			status: 'done',
			priority: 'p1',
			assignee: 'developer',
			reporter: 'orchestrator',
			attempts: 1,
			maxAttempts: 3,
			createdAt: '2026-09-13T05:36:28.320Z',
			updatedAt: '2026-09-13T06:14:23.159Z',
			completedAt: '2026-09-13T06:14:23.159Z',
			isEpic: false,
			epicId: null
		});
		expect(detail?.comments.map((c) => c.content)).toEqual(['first', 'done']);
		expect(detail?.comments[1].type).toBe('resolution');
	});

	test('coerces is_epic and epic_id, and treats a missing comments array as empty', () => {
		const detail = normaliseTaskDetail({ task: rawTask({ is_epic: 1, epic_id: 42 }) });
		expect(detail?.task.isEpic).toBe(true);
		expect(detail?.task.epicId).toBe(42);
		expect(detail?.comments).toEqual([]);
	});

	test('accepts boolean is_epic and nulls absent optional strings', () => {
		const detail = normaliseTaskDetail({
			task: rawTask({ is_epic: true, description: null, priority: null, assignee: null, completed_at: null })
		});
		expect(detail?.task.isEpic).toBe(true);
		expect(detail?.task.description).toBeNull();
		expect(detail?.task.priority).toBeNull();
		expect(detail?.task.assignee).toBeNull();
		expect(detail?.task.completedAt).toBeNull();
	});

	test('falls back for missing scalars (status unknown, comment type default, max_attempts)', () => {
		const detail = normaliseTaskDetail({
			task: { id: 7, title: 'bare' },
			comments: [{ id: 9, agent: 'a', content: 'c' }]
		});
		expect(detail?.task.status).toBe('unknown');
		expect(detail?.task.maxAttempts).toBe(3);
		expect(detail?.task.reporter).toBe('');
		expect(detail?.comments[0].type).toBe('comment');
		expect(detail?.comments[0].createdAt).toBe('');
	});

	test('returns null for a non-task payload', () => {
		expect(normaliseTaskDetail(null)).toBeNull();
		expect(normaliseTaskDetail('nope')).toBeNull();
		expect(normaliseTaskDetail([])).toBeNull();
		expect(normaliseTaskDetail({})).toBeNull();
		expect(normaliseTaskDetail({ task: { id: 1 } })).toBeNull(); // missing title
		expect(normaliseTaskDetail({ task: { title: 'x' } })).toBeNull(); // missing id
		expect(normaliseTaskDetail({ task: { id: 'x', title: 'y' } })).toBeNull();
	});

	test('drops non-record comment entries', () => {
		const detail = normaliseTaskDetail({
			task: rawTask(),
			comments: [null, 5, 'x', { id: 1, agent: 'a', content: 'ok', type: 'comment', created_at: 't' }]
		});
		expect(detail?.comments).toHaveLength(1);
		expect(detail?.comments[0].content).toBe('ok');
	});
});

describe('client-bundle safety (M4a)', () => {
	test('tracker.ts has no server-only or DOM imports', () => {
		const source = readFileSync(new URL('./tracker.ts', import.meta.url), 'utf8');
		const imports = source
			.split('\n')
			.filter((line) => /^\s*import\b/.test(line))
			.join('\n');
		expect(imports).not.toMatch(/\$lib\/server|bun:sqlite|opencode\.db|OPENCODE_DB/);
		expect(source).not.toMatch(/\bdocument\b|\bwindow\b/);
	});
});
