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

/**
 * Type guard for an already-normalised {@link TrackerTaskDetail} (camelCase) —
 * the shape our own `/api/tracker/task/:id` proxy returns.
 *
 * The modal fetches that proxy, so it must NOT run {@link normaliseTaskDetail}
 * again: the normaliser maps ziptask's snake_case fields and would silently
 * collapse a camelCase reply to defaults (empty timestamps, `maxAttempts` 3,
 * `epicId` null). This guard validates the camelCase contract instead, so a
 * malformed body still becomes a clean "unexpected response" error.
 */
export function isTaskDetail(value: unknown): value is TrackerTaskDetail {
	if (!isRecord(value) || !isRecord(value.task) || !Array.isArray(value.comments)) return false;
	const t = value.task;
	return (
		typeof t.id === 'number' &&
		typeof t.title === 'string' &&
		typeof t.status === 'string' &&
		typeof t.attempts === 'number' &&
		typeof t.maxAttempts === 'number' &&
		typeof t.createdAt === 'string' &&
		typeof t.updatedAt === 'string' &&
		(t.completedAt === null || typeof t.completedAt === 'string') &&
		typeof t.isEpic === 'boolean' &&
		(t.epicId === null || typeof t.epicId === 'number')
	);
}
