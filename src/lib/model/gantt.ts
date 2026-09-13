/**
 * Pure Gantt layout helpers (task #190 / ADR §7.2 item 2, §7.4).
 *
 * This module is imported by the client-side Gantt component, so it must stay
 * free of `$lib/server` / DB imports and of any DOM access. Every function is
 * deterministic and side-effect free, which keeps the SVG render testable.
 */
import type { GanttModel, Node } from './types';

/**
 * Distinct, pastel, blue/cyan-free (task #218) colors assigned to models in
 * first-seen order. Kept as 6-digit lowercase hex so SVG can append an alpha
 * suffix (e.g. `${color}33`); `hsl()`/named colors would break that.
 */
export const MODEL_PALETTE: readonly string[] = [
	'#efb99f',
	'#f0d789',
	'#d3e094',
	'#b0d99b',
	'#a1d9aa',
	'#a6d9c4',
	'#cfafde',
	'#deafdb',
	'#e5aec9',
	'#edabb6'
];

export type ToolTone = 'completed' | 'error' | 'running' | 'other';

/** Collapse a raw tool status string into one of four render tones. */
export function toolTone(status: string): ToolTone {
	switch (status.toLowerCase()) {
		case 'completed':
		case 'complete':
		case 'success':
			return 'completed';
		case 'error':
		case 'failed':
			return 'error';
		case 'running':
		case 'pending':
			return 'running';
		default:
			return 'other';
	}
}

/**
 * Assign a stable palette color to each distinct model id, in first-seen order.
 * `null`/unknown models are intentionally left out; callers render them muted.
 */
export function assignModelColors(modelIds: Array<string | null>): Map<string, string> {
	const colors = new Map<string, string>();
	let index = 0;
	for (const id of modelIds) {
		if (id === null || colors.has(id)) continue;
		colors.set(id, MODEL_PALETTE[index % MODEL_PALETTE.length]);
		index++;
	}
	return colors;
}

/**
 * Order nodes as the delegation tree: each parent immediately before its
 * children, siblings and roots by start time (ADR §7.2). Nodes whose parent is
 * absent from the set are treated as roots; a cycle guard prevents infinite
 * recursion on malformed data.
 */
export function orderNodes(nodes: Node[]): Node[] {
	const byId = new Map(nodes.map((node) => [node.sessionId, node]));
	const children = new Map<string, Node[]>();
	const roots: Node[] = [];

	for (const node of nodes) {
		const parent = node.parentSessionId;
		if (parent !== null && parent !== node.sessionId && byId.has(parent)) {
			const list = children.get(parent);
			if (list) list.push(node);
			else children.set(parent, [node]);
		} else {
			roots.push(node);
		}
	}

	const byStart = (a: Node, b: Node) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId);
	roots.sort(byStart);
	for (const list of children.values()) list.sort(byStart);

	const ordered: Node[] = [];
	const seen = new Set<string>();
	const visit = (node: Node) => {
		if (seen.has(node.sessionId)) return;
		seen.add(node.sessionId);
		ordered.push(node);
		for (const child of children.get(node.sessionId) ?? []) visit(child);
	};
	for (const root of roots) visit(root);
	// Defensive: include anything the traversal missed (should not happen).
	for (const node of nodes) visit(node);
	return ordered;
}

/** The shared horizontal axis domain for a turn. */
export interface TurnExtent {
	start: number;
	end: number;
}

/**
 * Axis domain: the model's turn window (`t0..t1`) widened by every node, step
 * and tool span actually present, so running nodes (`end=null`) still reach the
 * right edge. Degenerate windows are padded so the scale is never zero-width.
 */
export function turnExtent(model: GanttModel): TurnExtent {
	let start = model.t0;
	let end = model.t1;
	for (const node of model.nodes) {
		start = Math.min(start, node.startedAt);
		if (node.endedAt !== null) end = Math.max(end, node.endedAt);
	}
	for (const step of model.steps) {
		start = Math.min(start, step.startedAt);
		if (step.endedAt !== null) end = Math.max(end, step.endedAt);
	}
	for (const call of model.toolCalls) {
		if (call.startedAt !== null) start = Math.min(start, call.startedAt);
		if (call.endedAt !== null) end = Math.max(end, call.endedAt);
	}
	if (!Number.isFinite(start)) start = model.t0;
	if (!Number.isFinite(end) || end <= start) end = start + 1;
	return { start, end };
}

/** Chart width used before the container is measured (SSR / first paint). */
export const FALLBACK_CHART_W = 720;

/** The derived horizontal time scale for a turn. */
export interface TimeScale {
	/** Horizontal pixels per millisecond. */
	pxPerMs: number;
	/** Rendered SVG width in px; always equal to the available width. */
	chartWidth: number;
}

/**
 * Width-fitted time scale (task #224): the whole turn span is mapped onto
 * `availableWidth`, so the chart always fills its container and never overflows
 * horizontally. `availableWidth <= 0` (SSR / not yet measured) falls back to
 * {@link FALLBACK_CHART_W}; a non-positive/non-finite span degrades to 1 ms so
 * the geometry stays finite. Pure and deterministic.
 */
export function computeTimeScale(span: number, availableWidth: number): TimeScale {
	const safeSpan = Number.isFinite(span) && span > 0 ? span : 1;
	const safeWidth =
		Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : FALLBACK_CHART_W;
	const pxPerMs = safeWidth / safeSpan;
	return { pxPerMs, chartWidth: safeWidth };
}

/** Nice wall-clock tick intervals, in milliseconds, from 100 ms to 1 week. */
const NICE_STEPS = [
	100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
	900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
	172_800_000, 604_800_000
];

/**
 * Evenly spaced axis values using a human-friendly step. `targetCount` is a
 * hint (e.g. derived from the drawn width); the result may hold fewer ticks.
 */
export function buildTicks(start: number, end: number, targetCount: number): number[] {
	const span = end - start;
	if (!Number.isFinite(span) || span <= 0) return [start];
	const rawStep = span / Math.max(1, targetCount);
	const step = NICE_STEPS.find((candidate) => candidate >= rawStep) ?? NICE_STEPS[NICE_STEPS.length - 1];
	const first = Math.ceil(start / step) * step;
	const ticks: number[] = [];
	for (let time = first; time <= end && ticks.length < 5_000; time += step) ticks.push(time);
	return ticks;
}

/** Compact session id for row labels: `ses_ab12cd34ef56` -> `ses_ab12…ef56`. */
export function nodeShortId(sessionId: string): string {
	if (sessionId.length <= 16) return sessionId;
	return `${sessionId.slice(0, 10)}…${sessionId.slice(-4)}`;
}
