/**
 * Unit tests for nested Code Mode tool-call assembly (ADR D-2, task #1499).
 *
 * `buildToolCalls` is pure: it maps a hand-built {@link SessionData} to
 * {@link ToolCall} DTOs, so the documented nested-entry shape (one DTO per
 * `state.metadata.toolCalls[]` entry, `parentCallId` linking it to the parent
 * `execute` item) is asserted directly, without a DB. The node-detail half of
 * the AC is proven by feeding the emitted calls through the pure
 * `selectNodeDetail` — the same function behind the drill-down panel and the
 * `/api/sessions/[id]/nodes/[nodeId]` route.
 *
 * Pure and server-free: no DB, so it runs in the plain `bun test` process.
 */
import { describe, expect, test } from 'bun:test';
import { selectNodeDetail } from '../../../model/node';
import type { GanttModel, Node } from '../../../model/types';
import type { SessionSubtreeRecord } from '../../../server/queries/sessions';
import type { ContentRecord } from '../../schema';
import type { SessionData } from './shared';
import { buildToolCalls } from './tool-calls';

const T = 1_700_000_000_000;
/** `now` far past every fixture timestamp, so no end is clamped. */
const NOW = T + 100_000;

const session: SessionSubtreeRecord = {
	id: 'sess1',
	parentId: null,
	directory: '/repo/a',
	title: 'Nested',
	agent: 'build',
	modelId: null,
	providerId: null,
	createdAt: T,
	updatedAt: T + 100,
	archivedAt: null,
	cost: 0,
	usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
	depth: 0
};

/**
 * A `data.content[]` item with every field the mapper reads. The provider
 * call id (`$.id`) becomes `callId`; the record's own `id` is synthesised as
 * `messageId#index`, exactly as `mapContentRow` does.
 */
function contentItem(overrides: Partial<ContentRecord> & { callId: string; index: number }): ContentRecord {
	const base: ContentRecord = {
		id: `m1#${overrides.index}`,
		messageId: 'm1',
		sessionId: 'sess1',
		index: overrides.index,
		type: 'tool',
		name: null,
		status: 'completed',
		callId: overrides.callId,
		errorMessage: null,
		errorType: null,
		input: null,
		content: null,
		metadataSessionId: null,
		metadataStatus: null,
		agent: null,
		description: null,
		prompt: null,
		timeCreated: null,
		timeRan: null,
		timeCompleted: null,
		text: null,
		toolCalls: []
	};
	const { callId: _callId, index: _index, ...rest } = overrides;
	return { ...base, ...rest } as ContentRecord;
}

/** A plain top-level `bash` call. */
const bashItem = contentItem({
	callId: 'c-bash',
	index: 0,
	name: 'bash',
	input: '{"command":"ls"}',
	timeCreated: T,
	timeRan: T,
	timeCompleted: T + 10
});

/** The parent `execute` item carrying two nested Code Mode calls. */
const executeItem = contentItem({
	callId: 'c-exec',
	index: 1,
	name: 'execute',
	timeCreated: T + 20,
	timeRan: T + 20,
	timeCompleted: T + 30,
	toolCalls: [
		{ tool: 'synaptomind.memory_recall', status: 'completed', input: '{"query":"x"}' },
		{ tool: 'search', status: 'completed', input: '{"query":"y"}' }
	]
});

/** A plain-JS `execute` item with no nested calls. */
const plainExecuteItem = contentItem({
	callId: 'c-exec-plain',
	index: 2,
	name: 'execute',
	timeCreated: T + 40,
	timeRan: T + 40,
	timeCompleted: T + 50
});

function sessionData(toolItems: ContentRecord[]): SessionData {
	return { session, messages: [], toolItems, actionItems: [], compactions: [] };
}

describe('buildToolCalls — nested entries (ADR D-2)', () => {
	const calls = buildToolCalls(sessionData([bashItem, executeItem, plainExecuteItem]), null, NOW);
	const byId = new Map(calls.map((call) => [call.id, call]));

	test('emits one ToolCall per item plus one per nested entry', () => {
		// bash + execute + 2 nested + plain execute = 5; the plain `execute`
		// without nested calls emits only its own wrapper DTO.
		expect(calls.map((call) => call.id)).toEqual([
			'm1#0',
			'm1#1',
			'm1#1#n0',
			'm1#1#n1',
			'm1#2'
		]);
	});

	test('the parent execute wrapper is a basic, non-nested call', () => {
		const parent = byId.get('m1#1')!;
		expect(parent.name).toBe('execute');
		expect(parent.callId).toBe('c-exec');
		expect(parent.isMcp).toBe(false);
		expect(parent.isDelegation).toBe(false);
		expect(parent.parentCallId).toBeUndefined();
	});

	test('a nested entry carries the documented fields and parentCallId', () => {
		const nested = byId.get('m1#1#n0')!;
		expect(nested).toEqual({
			id: 'm1#1#n0',
			nodeId: 'sess1',
			stepId: null,
			callId: null,
			name: 'synaptomind.memory_recall',
			status: 'completed',
			error: null,
			startedAt: T + 20, // inherits the parent's timeRan
			endedAt: T + 30, // inherits the parent's timeCompleted
			flags: [],
			input: '{"query":"x"}',
			output: null,
			isMcp: true, // dot-namespaced -> MCP
			isDelegation: false,
			trackerRefs: [],
			parentCallId: 'm1#1'
		});
	});

	test('nested index advances per entry; search classifies basic', () => {
		const second = byId.get('m1#1#n1')!;
		expect(second.name).toBe('search');
		expect(second.isMcp).toBe(false);
		expect(second.parentCallId).toBe('m1#1');
	});

	test('nested entries are emitted right after their parent', () => {
		const ids = calls.map((call) => call.id);
		expect(ids.indexOf('m1#1#n0')).toBe(ids.indexOf('m1#1') + 1);
		expect(ids.indexOf('m1#1#n1')).toBe(ids.indexOf('m1#1#n0') + 1);
	});

	test('only execute items emit nested calls', () => {
		// A non-execute item carrying a toolCalls array is never expanded.
		const bashWithNested = contentItem({
			callId: 'c-bash-weird',
			index: 5,
			name: 'bash',
			toolCalls: [{ tool: 'ziptask.get_task', status: 'completed', input: '{}' }]
		});
		const out = buildToolCalls(sessionData([bashWithNested]), null, NOW);
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe('m1#5');
	});
});

describe('selectNodeDetail — the node detail includes nested calls', () => {
	const node: Node = {
		sessionId: 'sess1',
		parentSessionId: null,
		agent: 'build',
		kind: 'orchestrator',
		modelId: null,
		providerId: null,
		depth: 0,
		directory: '/repo/a',
		status: 'completed',
		startedAt: T,
		endedAt: T + 50,
		running: false,
		flags: [],
		usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
		stepCount: 0,
		toolCallCount: 5,
		errorCount: 0,
		compactionCount: 0,
		openStep: false
	};
	const model: GanttModel = {
		turnId: 'sess1_u1',
		rootSessionId: 'sess1',
		agent: 'build',
		t0: T,
		t1: T + 50,
		nodes: [node],
		edges: [],
		steps: [],
		toolCalls: buildToolCalls(sessionData([bashItem, executeItem, plainExecuteItem]), null, NOW),
		markers: []
	};

	test('the detail carries every nested call with parentCallId intact', () => {
		const detail = selectNodeDetail(model, 'sess1');
		expect(detail).not.toBeNull();
		expect(detail!.toolCalls.map((call) => call.id)).toEqual(['m1#0', 'm1#1', 'm1#1#n0', 'm1#1#n1', 'm1#2']);
		const nested = detail!.toolCalls.find((call) => call.id === 'm1#1#n0')!;
		expect(nested.parentCallId).toBe('m1#1');
		expect(nested.name).toBe('synaptomind.memory_recall');
	});

	test('a node without the calls yields an empty detail slice', () => {
		const detail = selectNodeDetail(model, 'other');
		expect(detail).toBeNull();
	});
});
