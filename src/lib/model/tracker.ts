/**
 * Pure inferred tracker-reference helpers (M4, spec §6 "ziptask link").
 *
 * Imported by the client-side `Gantt` component and the server-side turn
 * service, so this module must stay free of `$lib/server` / DB imports and of
 * any DOM access. Every function is deterministic and side-effect free.
 *
 * References are only ever *inferred* from tool-call input/output and spawn
 * prompts; the UI must label them as such.
 */
import type { Edge, GanttModel, Node, ToolCall } from './types';

/** Deduplicate refs preserving first-seen order (stable). Empty refs are dropped. */
export function mergeTrackerRefs(...lists: ReadonlyArray<readonly string[]>): string[] {
	const seen = new Set<string>();
	for (const list of lists) {
		for (const ref of list) {
			if (ref !== '' && !seen.has(ref)) seen.add(ref);
		}
	}
	return [...seen];
}

/** The number of chips a collapsed view shows before offering an expander. */
export const REF_COLLAPSE_LIMIT = 3;

/** A display view of a ref list: up to `max` chips plus a `N tasks` expander. */
export interface CollapsedTrackerRefs {
	/** Refs rendered while collapsed. */
	visible: string[];
	/** Refs hidden behind the expander while collapsed. */
	hidden: string[];
	/** `hidden.length`, exposed for convenience. */
	hiddenCount: number;
	/** Distinct refs in the list. */
	total: number;
	/** Expander label (`"4 tasks"`), or `null` when nothing is hidden. */
	expanderLabel: string | null;
}

/**
 * Collapse a ref list for display: at most `max` chips are shown; with four or
 * more distinct refs the remainder hides behind an `N tasks` expander
 * (spec §6). Deduplicates and keeps first-seen order.
 */
export function collapseTrackerRefs(
	refs: readonly string[],
	max = REF_COLLAPSE_LIMIT
): CollapsedTrackerRefs {
	const unique = mergeTrackerRefs(refs);
	const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
	const visible = unique.slice(0, limit);
	const hidden = unique.slice(limit);
	return {
		visible,
		hidden,
		hiddenCount: hidden.length,
		total: unique.length,
		expanderLabel: hidden.length > 0 ? `${unique.length} tasks` : null
	};
}

/**
 * The inferred refs of one node: its tool calls plus any `task` delegation edge
 * parented to it, deduplicated in first-seen order. A populated
 * `node.trackerRefs` (set by the turn service) is used verbatim.
 */
export function nodeTrackerRefs(
	node: Pick<Node, 'sessionId' | 'trackerRefs'>,
	toolCalls: readonly ToolCall[],
	edges: readonly Edge[]
): string[] {
	if (node.trackerRefs && node.trackerRefs.length > 0) return mergeTrackerRefs(node.trackerRefs);
	return mergeTrackerRefs(
		toolCalls.filter((call) => call.nodeId === node.sessionId).flatMap((call) => call.trackerRefs),
		edges.filter((edge) => edge.parentNodeId === node.sessionId).flatMap((edge) => edge.trackerRefs)
	);
}

/**
 * Every inferred ref of a turn: the union of node refs and raw tool-call / edge
 * refs, deduplicated in first-seen order.
 */
export function turnTrackerRefs(model: Pick<GanttModel, 'nodes' | 'toolCalls' | 'edges'>): string[] {
	return mergeTrackerRefs(
		model.nodes.flatMap((node) => node.trackerRefs ?? []),
		model.toolCalls.flatMap((call) => call.trackerRefs),
		model.edges.flatMap((edge) => edge.trackerRefs)
	);
}

// --- Task detail (experimental ziptask `GET /api/task/:id`) ------------------

/**
 * The subset of ziptask's task payload the modal renders. The upstream shape
 * is treated as untrusted, so it is normalised field by field.
 */
export interface TrackerTask {
	id: number;
	title: string;
	description: string | null;
	status: string;
	priority: string | null;
	assignee: string | null;
	reporter: string;
	attempts: number;
	maxAttempts: number;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	isEpic: boolean;
	epicId: number | null;
}

/** One ziptask comment (a human note or a terminal-transition resolution). */
export interface TrackerComment {
	id: number;
	agent: string;
	content: string;
	type: string;
	createdAt: string;
}

/** Normalised `GET /api/task/:id` payload: the task plus its comments. */
export interface TrackerTaskDetail {
	task: TrackerTask;
	comments: TrackerComment[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asOptionalNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Validate/coerce a raw ziptask task payload into {@link TrackerTaskDetail}.
 * Returns `null` when the payload is not a task object (bad/foreign response),
 * so callers can surface a clean error instead of rendering garbage.
 */
export function normaliseTaskDetail(raw: unknown): TrackerTaskDetail | null {
	if (!isRecord(raw) || !isRecord(raw.task)) return null;
	const t = raw.task;
	if (typeof t.id !== 'number' || typeof t.title !== 'string') return null;

	const task: TrackerTask = {
		id: t.id,
		title: t.title,
		description: asOptionalString(t.description),
		status: asString(t.status, 'unknown'),
		priority: asOptionalString(t.priority),
		assignee: asOptionalString(t.assignee),
		reporter: asString(t.reporter),
		attempts: asNumber(t.attempts),
		maxAttempts: asNumber(t.max_attempts, 3),
		createdAt: asString(t.created_at),
		updatedAt: asString(t.updated_at),
		completedAt: asOptionalString(t.completed_at),
		isEpic: t.is_epic === 1 || t.is_epic === true,
		epicId: asOptionalNumber(t.epic_id)
	};

	const comments: TrackerComment[] = Array.isArray(raw.comments)
		? raw.comments.filter(isRecord).map((c) => ({
				id: asNumber(c.id),
				agent: asString(c.agent),
				content: asString(c.content),
				type: asString(c.type, 'comment'),
				createdAt: asString(c.created_at)
			}))
		: [];

	return { task, comments };
}
