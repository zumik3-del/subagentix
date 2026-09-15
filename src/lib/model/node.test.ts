import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	buildDetailEntries,
	buildNodeRows,
	collectTrackerRefs,
	formatToolCallText,
	groupToolRetries,
	selectNodeDetail,
	summarizeStepTools,
	truncateText
} from './node';
import type { Action, GanttModel, Marker, Node, Step, ToolCall, Usage } from './types';

/**
 * Unit tests for the pure node drill-down helpers (task #196 / M3c, task #195,
 * task #218).
 *
 * `node.ts` is imported by the client-side `NodeDetailPanel`/`Gantt`
 * components, so it must stay deterministic, DOM-free and free of `$lib/server`
 * imports. These tests pin the slice selection, text truncation, retry
 * grouping, tool-summary and tracker-ref contracts the panel relies on.
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

function makeStep(overrides: Partial<Step> & { id: string; nodeId: string }): Step {
	return {
		messageId: 'm',
		index: 0,
		startedAt: 1_000,
		endedAt: 1_100,
		open: false,
		flags: [],
		reason: 'stop',
		usage: usage(),
		modelId: 'gpt-5',
		hasCompaction: false,
		toolCallIds: [],
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

function makeMarker(overrides: Partial<Marker> & { nodeId: string }): Marker {
	return { type: 'compaction', at: 1_500, ...overrides };
}

function makeAction(overrides: Partial<Action> & { id: string; nodeId: string }): Action {
	return {
		kind: 'text',
		at: 1_000,
		endedAt: null,
		label: 'text',
		summary: '',
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

describe('selectNodeDetail()', () => {
	test('returns the node plus only its own steps, tool calls and markers', () => {
		const rootNode = makeNode({ sessionId: 'root' });
		const childNode = makeNode({
			sessionId: 'child',
			parentSessionId: 'root',
			depth: 1,
			kind: 'subagent',
			agent: 'developer'
		});
		const rootStep = makeStep({ id: 'rs', nodeId: 'root' });
		const childStep = makeStep({ id: 'cs', nodeId: 'child' });
		const rootTool = makeTool({ id: 'rt', nodeId: 'root' });
		const childTool = makeTool({ id: 'ct', nodeId: 'child' });
		const rootMarker = makeMarker({ nodeId: 'root' });
		const childMarker = makeMarker({ nodeId: 'child', type: 'removed', at: null });

		const model = makeModel({
			nodes: [rootNode, childNode],
			steps: [rootStep, childStep],
			toolCalls: [rootTool, childTool],
			markers: [rootMarker, childMarker]
		});

		const detail = selectNodeDetail(model, 'child');
		expect(detail).not.toBeNull();
		expect(detail?.node).toBe(childNode);
		expect(detail?.steps).toEqual([childStep]);
		expect(detail?.toolCalls).toEqual([childTool]);
		expect(detail?.markers).toEqual([childMarker]);
	});

	test('preserves the model order of the selected node items', () => {
		const rootFirst = makeStep({ id: 'rs1', nodeId: 'root', startedAt: 100 });
		const rootSecond = makeStep({ id: 'rs2', nodeId: 'root', startedAt: 500 });
		const model = makeModel({
			nodes: [makeNode({ sessionId: 'root' })],
			steps: [rootFirst, makeStep({ id: 'cs', nodeId: 'child' }), rootSecond],
			toolCalls: [makeTool({ id: 'rt', nodeId: 'root' })],
			markers: [makeMarker({ nodeId: 'root' })]
		});
		const detail = selectNodeDetail(model, 'root');
		expect(detail?.steps.map((step) => step.id)).toEqual(['rs1', 'rs2']);
	});

	test('returns empty arrays for a node with no steps/tools/markers', () => {
		const model = makeModel({
			nodes: [makeNode({ sessionId: 'root' }), makeNode({ sessionId: 'child', parentSessionId: 'root' })],
			steps: [makeStep({ id: 'rs', nodeId: 'root' })],
			toolCalls: [makeTool({ id: 'rt', nodeId: 'root' })],
			markers: [makeMarker({ nodeId: 'root' })]
		});
		const detail = selectNodeDetail(model, 'child');
		expect(detail).not.toBeNull();
		expect(detail?.steps).toEqual([]);
		expect(detail?.toolCalls).toEqual([]);
		expect(detail?.markers).toEqual([]);
	});

	test('returns null for an unknown node id', () => {
		const model = makeModel({
			nodes: [makeNode({ sessionId: 'root' })],
			steps: [makeStep({ id: 'rs', nodeId: 'root' })]
		});
		expect(selectNodeDetail(model, 'does-not-exist')).toBeNull();
	});

	test('returns null for an empty model', () => {
		expect(selectNodeDetail(makeModel(), 'root')).toBeNull();
	});

	test('returns the same DTO shape as the API route (node/steps/toolCalls/markers)', () => {
		const model = makeModel({ nodes: [makeNode({ sessionId: 'root' })] });
		const detail = selectNodeDetail(model, 'root');
		expect(Object.keys(detail ?? {}).sort()).toEqual([
			'actions',
			'markers',
			'node',
			'steps',
			'toolCalls'
		]);
	});
});

describe('buildNodeRows()', () => {
	test('builds a start marker, numbered steps, and nests tool calls + actions', () => {
		const s1 = makeStep({
			id: 's1',
			nodeId: 'root',
			startedAt: 1_000,
			endedAt: 1_100,
			toolCallIds: ['t1']
		});
		const text = makeAction({ id: 'a1', nodeId: 'root', kind: 'text', at: 1_050, summary: 'hello' });
		const patch = makeAction({
			id: 'a2',
			nodeId: 'root',
			kind: 'patch',
			at: 300,
			label: 'patch',
			summary: '/a.ts, /b.ts'
		});
		const call = makeTool({ id: 't1', nodeId: 'root', startedAt: 1_000, stepId: null });
		const model = makeModel({
			nodes: [makeNode({ sessionId: 'root', startedAt: 1_000, endedAt: 2_000 })],
			steps: [s1],
			toolCalls: [call],
			actions: [text, patch]
		});
		const detail = selectNodeDetail(model, 'root');
		expect(detail).not.toBeNull();
		const rows = buildNodeRows(detail!);
		// `patch` precedes the first step -> top-level; the start marker leads the
		// step at the same timestamp; the tool + text nest under the step.
		expect(rows.map((row) => row.key)).toEqual(['patch:a2', 'start', 'step:s1']);
		expect(rows[1].kind).toBe('start');
		expect(rows[2].step).toBe(s1);
		expect(rows[2].stepIndex).toBe(0);
		// Tool attribution via step.toolCallIds (call.stepId is null).
		expect(rows[2].children.map((child) => child.key)).toEqual(['tool:t1', 'text:a1']);
		expect(rows[2].children[0].call).toBe(call);
		expect(rows[2].children[1].summary).toBe('hello');
	});

	test('keeps a user text as a top-level prompt and compaction top-level', () => {
		const prompt = makeAction({
			id: 'a0',
			nodeId: 'root',
			kind: 'text',
			at: 900,
			role: 'user',
			summary: 'do the thing'
		});
		const compaction = makeAction({ id: 'c1', nodeId: 'root', kind: 'compaction', at: 1_200 });
		const model = makeModel({
			nodes: [makeNode({ sessionId: 'root', startedAt: 1_000, endedAt: 1_500 })],
			steps: [makeStep({ id: 's1', nodeId: 'root', startedAt: 1_000, endedAt: 1_100 })],
			actions: [prompt, compaction]
		});
		const rows = buildNodeRows(selectNodeDetail(model, 'root')!);
		expect(rows.map((row) => row.key)).toEqual(['text:a0', 'start', 'step:s1', 'compaction:c1']);
		expect(rows[0].kind).toBe('prompt');
		expect(rows[0].summary).toBe('do the thing');
		expect(rows[3].kind).toBe('compaction');
	});

	test('keeps each step index even when steps and actions interleave', () => {
		const first = makeStep({ id: 's0', nodeId: 'root', startedAt: 100, endedAt: 150 });
		const second = makeStep({ id: 's1', nodeId: 'root', startedAt: 300, endedAt: 350 });
		const action = makeAction({ id: 'a', nodeId: 'root', kind: 'reasoning', at: 200 });
		const model = makeModel({
			nodes: [makeNode({ sessionId: 'root', startedAt: 0, endedAt: 400 })],
			steps: [first, second],
			actions: [action]
		});
		const rows = buildNodeRows(selectNodeDetail(model, 'root')!);
		expect(rows.map((row) => row.key)).toEqual(['start', 'step:s0', 'step:s1']);
		expect(rows[1].stepIndex).toBe(0);
		expect(rows[2].stepIndex).toBe(1);
		// The 200ms reasoning action is owned by the step started at 100.
		expect(rows[1].children.map((child) => child.key)).toEqual(['reasoning:a']);
		expect(rows[2].children).toEqual([]);
	});

	test('exposes the action id as the detail anchor for action rows', () => {
		const action = makeAction({ id: 'a7', nodeId: 'root', kind: 'text', at: 10 });
		const model = makeModel({
			nodes: [makeNode({ sessionId: 'root', startedAt: 100, endedAt: 200 })],
			steps: [makeStep({ id: 's0', nodeId: 'root', startedAt: 100, endedAt: 150 })],
			actions: [action]
		});
		const rows = buildNodeRows(selectNodeDetail(model, 'root')!);
		expect(rows.find((row) => row.kind === 'text')?.actionId).toBe('a7');
		expect(rows.find((row) => row.kind === 'step')?.actionId).toBeNull();
	});

	test('falls back to a top-level tool row for an unattributed call', () => {
		const call = makeTool({ id: 'orphan', nodeId: 'root', startedAt: 1_200 });
		const model = makeModel({
			nodes: [makeNode({ sessionId: 'root', startedAt: 1_000, endedAt: 1_500 })],
			steps: [makeStep({ id: 's0', nodeId: 'root', startedAt: 1_000, endedAt: 1_100 })],
			toolCalls: [call]
		});
		const rows = buildNodeRows(selectNodeDetail(model, 'root')!);
		expect(rows.map((row) => row.key)).toEqual(['start', 'step:s0', 'tool:orphan']);
		expect(rows[2].call).toBe(call);
	});
});

describe('buildDetailEntries()', () => {
	test('merges tool calls and actions chronologically with stable keys', () => {
		const tool = makeTool({ id: 't1', nodeId: 'root', startedAt: 200 });
		const action = makeAction({ id: 'a1', nodeId: 'root', kind: 'reasoning', at: 100 });
		const model = makeModel({
			nodes: [makeNode({ sessionId: 'root' })],
			toolCalls: [tool],
			actions: [action]
		});
		const entries = buildDetailEntries(selectNodeDetail(model, 'root')!);
		expect(entries.map((entry) => entry.key)).toEqual(['reasoning:a1', 'tool:t1']);
		expect(entries[1].kind).toBe('tool');
	});

	test('orders tool calls with no start time last', () => {
		const known = makeTool({ id: 'known', nodeId: 'root', startedAt: 500 });
		const unknown = makeTool({ id: 'unknown', nodeId: 'root', startedAt: null });
		const model = makeModel({
			nodes: [makeNode({ sessionId: 'root' })],
			toolCalls: [unknown, known]
		});
		expect(buildDetailEntries(selectNodeDetail(model, 'root')!).map((entry) => entry.key)).toEqual([
			'tool:known',
			'tool:unknown'
		]);
	});
});

describe('truncateText()', () => {
	test('leaves text below the limit untouched', () => {
		expect(truncateText('hello', 10)).toEqual({
			text: 'hello',
			truncated: false,
			originalLength: 5
		});
	});

	test('leaves text exactly at the limit untouched', () => {
		expect(truncateText('hello', 5)).toEqual({
			text: 'hello',
			truncated: false,
			originalLength: 5
		});
	});

	test('truncates text above the limit with an ellipsis and the original length', () => {
		expect(truncateText('hello world', 5)).toEqual({
			text: 'hello…',
			truncated: true,
			originalLength: 11
		});
	});

	test('uses a default limit of 400 characters', () => {
		expect(truncateText('x'.repeat(400)).truncated).toBe(false);
		const over = truncateText('x'.repeat(401));
		expect(over.truncated).toBe(true);
		expect(over.text).toBe(`${'x'.repeat(400)}…`);
		expect(over.originalLength).toBe(401);
	});

	test('treats null and the empty string as empty, non-truncated text', () => {
		for (const input of [null, '']) {
			expect(truncateText(input)).toEqual({
				text: '',
				truncated: false,
				originalLength: 0
			});
		}
	});

	test('clamps a non-positive / non-finite limit to zero', () => {
		const truncatedOnce = { text: '…', truncated: true, originalLength: 3 };
		for (const max of [0, -1, -400, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(truncateText('abc', max)).toEqual(truncatedOnce);
			// An empty string stays empty rather than becoming just an ellipsis.
			expect(truncateText('', max)).toEqual({ text: '', truncated: false, originalLength: 0 });
		}
	});

	test('floors a fractional limit', () => {
		expect(truncateText('abcdef', 3.9).text).toBe('abc…');
	});

	test('counts UTF-16 code units for multibyte text (documented, not code-point safe)', () => {
		// An emoji outside the BMP is two UTF-16 code units, so `'😀😀'` has length 4.
		const atBoundary = truncateText('😀😀', 2);
		expect(atBoundary.truncated).toBe(true);
		expect(atBoundary.text).toBe('😀…');
		expect(atBoundary.originalLength).toBe(4);

		// A limit that lands mid-surrogate splits the pair; length is preserved
		// (3 code units + the ellipsis). Reported as a low-severity observation:
		// truncation is not code-point safe for astral characters.
		const misaligned = truncateText('😀😀', 3);
		expect(misaligned.truncated).toBe(true);
		expect(misaligned.originalLength).toBe(4);
		expect(misaligned.text.length).toBe(4);
		expect(misaligned.text.endsWith('…')).toBe(true);
	});
});

describe('groupToolRetries()', () => {
	test('returns nothing for empty input or a single invocation per name', () => {
		expect(groupToolRetries([])).toEqual([]);
		expect(
			groupToolRetries([
				makeTool({ id: 'a', nodeId: 'n', name: 'bash' }),
				makeTool({ id: 'b', nodeId: 'n', name: 'read' })
			])
		).toEqual([]);
	});

	test('groups repeated invocations of the same name and counts the retries', () => {
		const first = makeTool({ id: 'a', nodeId: 'n', name: 'bash', startedAt: 100 });
		const second = makeTool({ id: 'b', nodeId: 'n', name: 'bash', startedAt: 200 });
		const third = makeTool({ id: 'c', nodeId: 'n', name: 'bash', startedAt: 300 });
		const groups = groupToolRetries([first, second, third]);
		expect(groups).toHaveLength(1);
		expect(groups[0].name).toBe('bash');
		expect(groups[0].calls.map((call) => call.id)).toEqual(['a', 'b', 'c']);
		expect(groups[0].retryCount).toBe(2);
		expect(groups[0].hasError).toBe(false);
	});

	test('does not merge distinct tool names', () => {
		const groups = groupToolRetries([
			makeTool({ id: 'a', nodeId: 'n', name: 'bash', startedAt: 100 }),
			makeTool({ id: 'b', nodeId: 'n', name: 'bash', startedAt: 300 }),
			makeTool({ id: 'c', nodeId: 'n', name: 'read', startedAt: 200 }),
			makeTool({ id: 'd', nodeId: 'n', name: 'read', startedAt: 400 })
		]);
		expect(groups.map((group) => group.name)).toEqual(['bash', 'read']);
		expect(groups.map((group) => group.calls.length)).toEqual([2, 2]);
	});

	test('orders groups by their first invocation and calls within a group by start time', () => {
		const groups = groupToolRetries([
			makeTool({ id: 'b_late', nodeId: 'n', name: 'b', startedAt: 500 }),
			makeTool({ id: 'b_early', nodeId: 'n', name: 'b', startedAt: 400 }),
			makeTool({ id: 'a_late', nodeId: 'n', name: 'a', startedAt: 300 }),
			makeTool({ id: 'a_early', nodeId: 'n', name: 'a', startedAt: 100 })
		]);
		// Group `a` starts first (100) so it comes before `b` (400).
		expect(groups.map((group) => group.name)).toEqual(['a', 'b']);
		expect(groups[0].calls.map((call) => call.id)).toEqual(['a_early', 'a_late']);
		expect(groups[1].calls.map((call) => call.id)).toEqual(['b_early', 'b_late']);
	});

	test('breaks equal start times by id for a stable order', () => {
		const groups = groupToolRetries([
			makeTool({ id: 'zzz', nodeId: 'n', name: 'bash', startedAt: 100 }),
			makeTool({ id: 'aaa', nodeId: 'n', name: 'bash', startedAt: 100 })
		]);
		expect(groups[0].calls.map((call) => call.id)).toEqual(['aaa', 'zzz']);
	});

	test('sorts a call with a null start time after timed calls', () => {
		const groups = groupToolRetries([
			makeTool({ id: 'no-start', nodeId: 'n', name: 'bash', startedAt: null }),
			makeTool({ id: 'timed', nodeId: 'n', name: 'bash', startedAt: 100 })
		]);
		expect(groups[0].calls.map((call) => call.id)).toEqual(['timed', 'no-start']);
	});

	test('flags a group that contains any failed invocation (case-insensitive)', () => {
		const groups = groupToolRetries([
			makeTool({ id: 'a', nodeId: 'n', name: 'bash', status: 'completed', startedAt: 100 }),
			makeTool({ id: 'b', nodeId: 'n', name: 'bash', status: 'ERROR', startedAt: 200 })
		]);
		expect(groups[0].hasError).toBe(true);
	});

	test('does not mutate the input array order', () => {
		const input = [
			makeTool({ id: 'late', nodeId: 'n', name: 'bash', startedAt: 300 }),
			makeTool({ id: 'early', nodeId: 'n', name: 'bash', startedAt: 100 })
		];
		groupToolRetries(input);
		expect(input.map((call) => call.id)).toEqual(['late', 'early']);
	});
});

describe('summarizeStepTools()', () => {
	test('returns the empty summary for no calls', () => {
		expect(summarizeStepTools([])).toEqual({
			names: [],
			count: 0,
			errorCount: 0,
			label: ''
		});
	});

	test('lists unique names in first-seen (start) order and counts every call', () => {
		const summary = summarizeStepTools([
			makeTool({ id: 'a', nodeId: 'n', name: 'read', startedAt: 100 }),
			makeTool({ id: 'b', nodeId: 'n', name: 'bash', startedAt: 200 }),
			makeTool({ id: 'c', nodeId: 'n', name: 'grep', startedAt: 300 })
		]);
		expect(summary.names).toEqual(['read', 'bash', 'grep']);
		expect(summary.count).toBe(3);
		expect(summary.errorCount).toBe(0);
		expect(summary.label).toBe('read, bash, grep');
	});

	test('collapses repeats to `name ×N`, keeping the first-seen position', () => {
		const summary = summarizeStepTools([
			makeTool({ id: 'a', nodeId: 'n', name: 'read', startedAt: 100 }),
			makeTool({ id: 'b', nodeId: 'n', name: 'bash', startedAt: 200 }),
			makeTool({ id: 'c', nodeId: 'n', name: 'bash', startedAt: 300 }),
			makeTool({ id: 'd', nodeId: 'n', name: 'grep', startedAt: 400 })
		]);
		expect(summary.names).toEqual(['read', 'bash', 'grep']);
		expect(summary.count).toBe(4);
		expect(summary.label).toBe('read, bash ×2, grep');
	});

	test('orders by start time with null last and an id tie-break', () => {
		const summary = summarizeStepTools([
			makeTool({ id: 'z', nodeId: 'n', name: 'late', startedAt: 300 }),
			makeTool({ id: 'no-time', nodeId: 'n', name: 'unknown-time', startedAt: null }),
			makeTool({ id: 'a', nodeId: 'n', name: 'early', startedAt: 100 }),
			makeTool({ id: 'bb', nodeId: 'n', name: 'tie-b', startedAt: 200 }),
			makeTool({ id: 'aa', nodeId: 'n', name: 'tie-a', startedAt: 200 })
		]);
		expect(summary.names).toEqual(['early', 'tie-a', 'tie-b', 'late', 'unknown-time']);
		expect(summary.label).toBe('early, tie-a, tie-b, late, unknown-time');
	});

	test('counts error/failed statuses case-insensitively', () => {
		const summary = summarizeStepTools([
			makeTool({ id: 'a', nodeId: 'n', name: 'bash', status: 'error' }),
			makeTool({ id: 'b', nodeId: 'n', name: 'read', status: 'FAILED' }),
			makeTool({ id: 'c', nodeId: 'n', name: 'grep', status: 'Completed' })
		]);
		expect(summary.count).toBe(3);
		expect(summary.errorCount).toBe(2);
	});

	test('does not mutate the input array order', () => {
		const input = [
			makeTool({ id: 'b', nodeId: 'n', name: 'bash', startedAt: 200 }),
			makeTool({ id: 'a', nodeId: 'n', name: 'read', startedAt: 100 })
		];
		const summary = summarizeStepTools(input);
		expect(summary).toEqual({
			names: ['read', 'bash'],
			count: 2,
			errorCount: 0,
			label: 'read, bash'
		});
		expect(input.map((call) => call.id)).toEqual(['b', 'a']);
	});
});

describe('collectTrackerRefs()', () => {
	test('returns nothing for empty input or calls without refs', () => {
		expect(collectTrackerRefs([])).toEqual([]);
		expect(
			collectTrackerRefs([
				makeTool({ id: 'a', nodeId: 'n', trackerRefs: [] }),
				makeTool({ id: 'b', nodeId: 'n', trackerRefs: [] })
			])
		).toEqual([]);
	});

	test('deduplicates refs across calls while preserving first-seen order', () => {
		const refs = collectTrackerRefs([
			makeTool({ id: 'a', nodeId: 'n', trackerRefs: ['185', '42'] }),
			makeTool({ id: 'b', nodeId: 'n', trackerRefs: ['42', '7'] }),
			makeTool({ id: 'c', nodeId: 'n', trackerRefs: ['185'] })
		]);
		expect(refs).toEqual(['185', '42', '7']);
	});

	test('preserves the order of refs within a single call', () => {
		expect(
			collectTrackerRefs([makeTool({ id: 'a', nodeId: 'n', trackerRefs: ['9', '3', '12'] })])
		).toEqual(['9', '3', '12']);
	});
});

describe('client-bundle safety (M3c)', () => {
	test('node.ts has no server-only or DOM imports', () => {
		const source = readFileSync(new URL('./node.ts', import.meta.url), 'utf8');
		const imports = source
			.split('\n')
			.filter((line) => /^\s*import\b/.test(line))
			.join('\n');
		expect(imports).not.toMatch(/\$lib\/server|bun:sqlite|opencode\.db|OPENCODE_DB/);
		expect(source).not.toMatch(/\bdocument\b|\bwindow\b/);
	});
});

describe('formatToolCallText() (task #230)', () => {
	test('renders name, status, timing and null input/output as empty sections', () => {
		const call = makeTool({ id: 't1', nodeId: 'n', name: 'bash', status: 'completed' });
		const text = formatToolCallText(call);
		const lines = text.split('\n');
		expect(lines[0]).toBe('bash');
		expect(lines).toContain('status: completed');
		expect(lines).toContain('input:');
		expect(lines).toContain(''); // null input → empty line
		expect(lines).toContain('output:');
		expect(lines).toContain(''); // null output → empty line
	});

	test('includes error when present', () => {
		const call = makeTool({ id: 't1', nodeId: 'n', name: 'read', status: 'error', error: 'ENOENT' });
		expect(formatToolCallText(call)).toContain('error: ENOENT');
	});

	test('marks MCP and delegation kinds', () => {
		const mcp = makeTool({ id: 't1', nodeId: 'n', name: 'recall', isMcp: true });
		expect(formatToolCallText(mcp)).toContain('kind: MCP');
		const deleg = makeTool({ id: 't2', nodeId: 'n', name: 'task', isDelegation: true });
		expect(formatToolCallText(deleg)).toContain('kind: delegation');
		const both = makeTool({ id: 't3', nodeId: 'n', name: 'mcp_task', isMcp: true, isDelegation: true });
		expect(formatToolCallText(both)).toContain('kind: MCP, delegation');
	});

	test('renders unknown start/end when timestamps are null', () => {
		const call = makeTool({ id: 't1', nodeId: 'n', name: 'bash', startedAt: null, endedAt: null });
		const text = formatToolCallText(call);
		expect(text).toContain('start: unknown');
		expect(text).toContain('end: running');
		expect(text).toContain('duration: unknown');
	});

	test('is pure and deterministic: same input yields identical output', () => {
		const call = makeTool({
			id: 't1',
			nodeId: 'n',
			name: 'grep',
			status: 'completed',
			input: 'pattern',
			output: 'result',
			startedAt: 1_700_000_000_000,
			endedAt: 1_700_000_001_000
		});
		expect(formatToolCallText(call)).toBe(formatToolCallText(call));
	});

		test('null and empty strings in input/output render as empty lines', () => {
			const withEmpty = makeTool({ id: 't1', nodeId: 'n', name: 'cmd', input: '', output: '' });
			const lines = formatToolCallText(withEmpty).split('\n');
			const inputIdx = lines.indexOf('input:');
			expect(lines[inputIdx + 1]).toBe('');
			const outputIdx = lines.indexOf('output:');
			expect(lines[outputIdx + 1]).toBe('');
		});

		test('shifts start:/end: to the given tz (default stays UTC)', () => {
			const call = makeTool({
				id: 't1',
				nodeId: 'n',
				name: 'bash',
				status: 'completed',
				startedAt: 1_700_000_000_000,
				endedAt: 1_700_000_001_000
			});
			// Default (UTC): 2023-11-14 22:13:20 / 22:13:21
			const utc = formatToolCallText(call);
			expect(utc).toContain('start: 2023-11-14 22:13:20');
			expect(utc).toContain('end: 2023-11-14 22:13:21');
			// Asia/Kolkata (UTC+5:30) rolls the date forward: 2023-11-15 03:43:20 / 03:43:21
			const kolkata = formatToolCallText(call, 'Asia/Kolkata');
			expect(kolkata).toContain('start: 2023-11-15 03:43:20');
			expect(kolkata).toContain('end: 2023-11-15 03:43:21');
			// America/New_York in EST (UTC-5, post-DST Nov 14 2023): 2023-11-14 17:13:20
			const ny = formatToolCallText(call, 'America/New_York');
			expect(ny).toContain('start: 2023-11-14 17:13:20');
			expect(ny).toContain('end: 2023-11-14 17:13:21');
		});
	});
