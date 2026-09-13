/**
 * Pure node drill-down helpers (M3c).
 *
 * Imported by the client-side `NodeDetailPanel`/`Gantt` components, so this
 * module must stay free of `$lib/server` / DB imports and of any DOM access.
 * Everything here is deterministic and side-effect free.
 */
import { formatDateTime, formatDuration } from './format';
import type { Action, ActionKind, GanttModel, NodeDetail, Step, ToolCall } from './types';

/**
 * Select one node's slice of an already-built {@link GanttModel}: the node plus
 * only its steps, tool calls and markers. Returns `null` when the node is not
 * part of the model. This is the instant, fetch-free counterpart of the
 * `/api/sessions/[id]/nodes/[nodeId]` service (same shape).
 */
export function selectNodeDetail(model: GanttModel, nodeId: string): NodeDetail | null {
	const node = model.nodes.find((candidate) => candidate.sessionId === nodeId);
	if (!node) return null;
	return {
		node,
		steps: model.steps.filter((step) => step.nodeId === nodeId),
		toolCalls: model.toolCalls.filter((call) => call.nodeId === nodeId),
		markers: model.markers.filter((marker) => marker.nodeId === nodeId),
		actions: (model.actions ?? []).filter((action) => action.nodeId === nodeId)
	};
}

/**
 * Row kinds of the drill-down timeline: a synthetic node-start marker, the
 * LLM steps, their tool/action children, and the `prompt` marker for a user
 * message's `text`.
 */
export type NodeRowKind = 'start' | 'step' | 'tool' | 'prompt' | ActionKind;

/**
 * One row of the hierarchical Steps & actions timeline. Top-level rows are
 * chronological node events (start marker, prompt, compaction, orphan tool
 * calls, and the numbered steps); a step's `children` hold the tool calls and
 * non-tool actions it produced. Pure data — the panel owns presentation.
 */
export interface NodeRow {
	key: string;
	kind: NodeRowKind;
	at: number;
	endedAt: number | null;
	/** 0-based index among the node's steps; `null` for non-step rows. */
	stepIndex: number | null;
	/** The step for step rows, else `null`. */
	step: Step | null;
	/** The tool call for tool rows, else `null`. */
	call: ToolCall | null;
	/** Action id for action rows (the detail anchor); `null` otherwise. */
	actionId: string | null;
	/** Display label (kind, tool name, filename, …). */
	label: string;
	summary: string;
	/** Child rows (tool calls + actions) of a step; empty otherwise. */
	children: NodeRow[];
}

function rowSort(a: NodeRow, b: NodeRow): number {
	return a.at - b.at || a.key.localeCompare(b.key);
}

/** Tool calls attributed to a step, ordered by start (unknown last) then id. */
function stepCallsOf(step: Step, calls: ToolCall[]): ToolCall[] {
	return calls
		.filter((call) => call.stepId === step.id || step.toolCallIds.includes(call.id))
		.sort(
			(a, b) =>
				(a.startedAt ?? Number.POSITIVE_INFINITY) -
					(b.startedAt ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id)
		);
}

/** The latest step that started at or before `at` (steps are pre-sorted). */
function stepOwning(steps: Step[], at: number): Step | null {
	let owner: Step | null = null;
	for (const step of steps) {
		if (step.startedAt > at) break;
		owner = step;
	}
	return owner;
}

function toolRow(call: ToolCall, fallbackAt: number): NodeRow {
	return {
		key: `tool:${call.id}`,
		kind: 'tool',
		at: call.startedAt ?? call.endedAt ?? fallbackAt,
		endedAt: call.endedAt,
		stepIndex: null,
		step: null,
		call,
		actionId: null,
		label: call.name,
		summary: call.status,
		children: []
	};
}

function actionRow(action: Action): NodeRow {
	return {
		key: `${action.kind}:${action.id}`,
		kind: action.kind,
		at: action.at,
		endedAt: action.endedAt,
		stepIndex: null,
		step: null,
		call: null,
		actionId: action.id,
		label: action.label,
		summary: action.summary,
		children: []
	};
}

/**
 * Build the hierarchical drill-down timeline from one node's slice. Pure and
 * deterministic:
 *
 * - a synthetic `start` marker (node agent/model) always leads;
 * - every LLM step is a numbered top-level row carrying its usage;
 * - its tool calls (`stepId`/`toolCallIds`) and non-tool actions (attributed by
 *   time to the nearest preceding step) become its `children`;
 * - a user message's `text` becomes a `prompt` marker, compactions stay
 *   top-level markers, and any tool call not attributed to a step falls back
 *   to a top-level `tool` row.
 *
 * Top-level rows are ordered by `at`, ties by key; children likewise.
 */
export function buildNodeRows(detail: NodeDetail): NodeRow[] {
	const steps = [...detail.steps].sort(
		(a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)
	);
	const childrenByStep = new Map<string, NodeRow[]>();
	for (const step of steps) childrenByStep.set(step.id, []);

	const attributed = new Set<string>();
	for (const step of steps) {
		for (const call of stepCallsOf(step, detail.toolCalls)) {
			attributed.add(call.id);
			childrenByStep.get(step.id)!.push(toolRow(call, step.startedAt));
		}
	}

	const top: NodeRow[] = [];
	for (const action of detail.actions ?? []) {
		const row = actionRow(action);
		if (action.kind === 'compaction' || action.role === 'user') {
			top.push(action.kind === 'text' && action.role === 'user' ? { ...row, kind: 'prompt' } : row);
			continue;
		}
		const owner = stepOwning(steps, action.at);
		if (owner) childrenByStep.get(owner.id)!.push(row);
		else top.push(row);
	}

	for (const call of detail.toolCalls) {
		if (!attributed.has(call.id)) top.push(toolRow(call, detail.node.startedAt));
	}

	const stepRows: NodeRow[] = steps.map((step, index) => ({
		key: `step:${step.id}`,
		kind: 'step',
		at: step.startedAt,
		endedAt: step.endedAt,
		stepIndex: index,
		step,
		call: null,
		actionId: null,
		label: step.reason ?? (step.open ? 'open' : 'step'),
		summary: '',
		children: (childrenByStep.get(step.id) ?? []).sort(rowSort)
	}));

	top.push({
		key: 'start',
		kind: 'start',
		at: detail.node.startedAt,
		endedAt: detail.node.endedAt,
		stepIndex: null,
		step: null,
		call: null,
		actionId: null,
		label: detail.node.agent,
		summary: detail.node.modelId ?? '',
		children: []
	});

	return [...top, ...stepRows].sort(rowSort);
}

/** One entry of the unified details list: a tool call or a non-tool action. */
export type DetailEntry =
	| { key: string; kind: 'tool'; at: number | null; call: ToolCall }
	| { key: string; kind: ActionKind; at: number; action: Action };

/**
 * Merge a node's tool calls and non-tool actions into one chronologically
 * ordered details list (the anchor target of the table rows). Pure and
 * deterministic: ordered by `at` (unknown tool starts last), ties by key.
 */
export function buildDetailEntries(detail: NodeDetail): DetailEntry[] {
	const entries: DetailEntry[] = [];
	for (const call of detail.toolCalls) {
		entries.push({ key: `tool:${call.id}`, kind: 'tool', at: call.startedAt, call });
	}
	for (const action of detail.actions ?? []) {
		entries.push({ key: `${action.kind}:${action.id}`, kind: action.kind, at: action.at, action });
	}
	entries.sort(
		(a, b) =>
			(a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY) ||
			a.key.localeCompare(b.key)
	);
	return entries;
}

/** The result of truncating a long text blob for display. */
export interface TruncatedText {
	/** Text to render; suffixed with `…` when shortened. */
	text: string;
	/** Whether the original text was longer than `max`. */
	truncated: boolean;
	/** Length of the original text in characters. */
	originalLength: number;
}

/**
 * Truncate a text blob to `max` characters for the call list. `null`/empty
 * input yields an empty, non-truncated result; a non-positive `max` clamps to
 * zero. The UI renders `text` and offers an expand toggle when `truncated`.
 */
export function truncateText(text: string | null, max = 400): TruncatedText {
	const source = text ?? '';
	const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
	if (source.length <= limit) {
		return { text: source, truncated: false, originalLength: source.length };
	}
	return { text: `${source.slice(0, limit)}…`, truncated: true, originalLength: source.length };
}

/** One tool name invoked more than once (a retry group). */
export interface ToolRetryGroup {
	/** The shared tool/MCP name. */
	name: string;
	/** Every invocation of that name, in start order. */
	calls: ToolCall[];
	/** Extra invocations beyond the first (`calls.length - 1`). */
	retryCount: number;
	/** Whether any invocation failed. */
	hasError: boolean;
}

function callSortTime(call: ToolCall): number {
	return call.startedAt ?? Number.POSITIVE_INFINITY;
}

/**
 * Group repeat invocations of the same tool/MCP name (retry heuristic, spec
 * §4). Only names invoked more than once are returned; groups are ordered by
 * their first invocation and calls within a group by start time (ties by id).
 */
export function groupToolRetries(toolCalls: ToolCall[]): ToolRetryGroup[] {
	const byName = new Map<string, ToolCall[]>();
	for (const call of toolCalls) {
		const list = byName.get(call.name);
		if (list) list.push(call);
		else byName.set(call.name, [call]);
	}
	const groups: ToolRetryGroup[] = [];
	for (const [name, calls] of byName) {
		if (calls.length < 2) continue;
		calls.sort((a, b) => callSortTime(a) - callSortTime(b) || a.id.localeCompare(b.id));
		groups.push({
			name,
			calls,
			retryCount: calls.length - 1,
			hasError: calls.some((call) => call.status.toLowerCase() === 'error')
		});
	}
	groups.sort((a, b) => callSortTime(a.calls[0]) - callSortTime(b.calls[0]));
	return groups;
}

/** Per-step rollup of tool calls for the Steps table (task #218). */
export interface StepToolSummary {
	/** Distinct tool/MCP names in first-invoked order. */
	names: string[];
	/** Total tool calls attributed to the step. */
	count: number;
	/** Calls whose status is `error`/`failed` (case-insensitive). */
	errorCount: number;
	/** `name` (or `name ×N` for repeats) joined by `", "`; empty with no calls. */
	label: string;
}

/**
 * Summarize a step's tool calls for display (task #218). Pure and
 * deterministic: calls are ordered by start time (unknown last) then id, names
 * keep first-seen order, and repeats of a name collapse to `name ×N`.
 */
export function summarizeStepTools(calls: ToolCall[]): StepToolSummary {
	const ordered = [...calls].sort(
		(a, b) => callSortTime(a) - callSortTime(b) || a.id.localeCompare(b.id)
	);
	const counts = new Map<string, number>();
	let errorCount = 0;
	for (const call of ordered) {
		counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
		const status = call.status.toLowerCase();
		if (status === 'error' || status === 'failed') errorCount += 1;
	}
	const names = [...counts.keys()];
	const label = names
		.map((name) => {
			const count = counts.get(name) ?? 0;
			return count > 1 ? `${name} ×${count}` : name;
		})
		.join(', ');
	return { names, count: ordered.length, errorCount, label };
}

/**
 * Human-readable, **untruncated** dump of one tool/MCP call for the copy button
 * (task #230). Pure and deterministic: fixed field order, UTC timestamps
 * ({@link formatDateTime}) and the display duration ({@link formatDuration});
 * the exact same text is produced in tests and at click time. Missing
 * input/output become an empty section; a missing start/end is spelled out.
 */
export function formatToolCallText(call: ToolCall): string {
	const lines: string[] = [call.name];
	const markers: string[] = [];
	if (call.isMcp) markers.push('MCP');
	if (call.isDelegation) markers.push('delegation');
	if (markers.length > 0) lines.push(`kind: ${markers.join(', ')}`);
	lines.push(`status: ${call.status}`);
	lines.push(`start: ${call.startedAt === null ? 'unknown' : formatDateTime(call.startedAt)}`);
	lines.push(`end: ${call.endedAt === null ? 'running' : formatDateTime(call.endedAt)}`);
	lines.push(
		`duration: ${call.startedAt === null ? 'unknown' : formatDuration(call.startedAt, call.endedAt)}`
	);
	if (call.error) lines.push(`error: ${call.error}`);
	lines.push('input:');
	lines.push(call.input ?? '');
	lines.push('output:');
	lines.push(call.output ?? '');
	return lines.join('\n');
}

/**
 * Deduplicated, order-preserving ziptask references inferred for a node from
 * its tool calls (spec §6 "ziptask link"). Never authoritative — the UI labels
 * them as inferred.
 */
export function collectTrackerRefs(toolCalls: ToolCall[]): string[] {
	const refs = new Set<string>();
	for (const call of toolCalls) {
		for (const ref of call.trackerRefs) refs.add(ref);
	}
	return [...refs];
}
