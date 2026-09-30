/**
 * Server-free domain types for the top-tools error detail (task #481).
 *
 * Imported by the server query/service, the route handler and the client
 * `ToolErrorsModal`, so it must stay free of `$lib/server` / DB imports and of
 * any DOM/Svelte dependency. Pure and deterministic; no I/O.
 *
 * "Failed" is deliberately unified with the top-tools aggregate: a content item
 * counts when its `$.state.status` is `error` **or** `failed` (the same pair
 * `model/node.ts` uses), so the widget's errors column and this detail's
 * unfiltered total are the same number within the shared session ceiling.
 *
 * Since #484 the detail has two modes: `errors` (failed only, the default and
 * the unchanged `?toolErrors=` deep link) and `all` (every tool call, the
 * `?toolCalls=` deep link). The mode is the base content-item predicate, so
 * rows, total and the agent options all honour it.
 */

/**
 * Which tool-call rows the detail lists: `errors` (failed only) or `all`
 * (every call). Sent as `?status=`, default {@link DEFAULT_TOOL_CALL_STATUS}.
 */
export type ToolCallStatus = 'errors' | 'all';

/** Default `?status=` when absent/blank: failures only. */
export const DEFAULT_TOOL_CALL_STATUS: ToolCallStatus = 'errors';

/** True for the two supported `?status=` values. */
export function isToolCallStatus(value: unknown): value is ToolCallStatus {
	return value === 'errors' || value === 'all';
}

/**
 * The overlay target the shell keeps in the URL: the tool and the mode it was
 * opened in (`?toolErrors=` = failures, `?toolCalls=` = all calls).
 */
export interface ToolCallDetail {
	/** Exact content-item `$.name` the overlay is filtered to. */
	tool: string;
	/** `errors` = failures only; `all` = every call. */
	mode: ToolCallStatus;
}

/**
 * One tool call, flattened for the detail table.
 *
 * Since #538 a row also carries the fields the shared `ToolCallDetail` card
 * needs (`input`/`output`/`endedAt` plus the two name-derived flags), so a row
 * can be expanded into the same record the Gantt node inspector shows. In V2 the
 * row is a `data.content[]` tool item (spec §P4/AC4.c).
 */
export interface ToolErrorEntry {
	/** The content item's `$.id` (provider call id); stable row key. */
	id: string;
	/** Owning session id. */
	sessionId: string;
	/** The owning `session_message.time_created` (epoch-ms). */
	at: number;
	/** `session_v2.agent`; `unknown` for a NULL/blank agent. */
	agent: string;
	/** The content item's `$.name`; `unknown` for a NULL/blank tool. */
	tool: string;
	/** Raw `$.state.status`; empty string when the item has no status. */
	status: string;
	/** `$.state.error.message`; empty string when the item carries no error text. */
	error: string;
	/** `$.state.input` (raw); `null` when absent. */
	input: string | null;
	/** The joined `$.state.content` text items, capped; `null` when absent. */
	output: string | null;
	/** The item's `$.time.completed`; `null` => still running / no end recorded. */
	endedAt: number | null;
	/** True when `tool` is outside the built-in allowlist (MCP). */
	isMcp: boolean;
	/** True for the `subagent` delegation tool (V2's former `task`). */
	isDelegation: boolean;
}

/**
 * The paged detail payload (`GET /api/dashboard/tool-errors`):
 * one page of tool calls (failures only or every call, per `status`) plus the
 * honest totals the filters were applied against. `agents` is the stable agent
 * option list (computed before the tool/agent/search filters, so selecting an
 * agent never collapses it).
 */
export interface ToolErrorsPage {
	/** Current page, newest first. */
	rows: ToolErrorEntry[];
	/** Rows matching every active filter (not just the current page). */
	total: number;
	/** Distinct agents in the base set (per `status`), ascending. */
	agents: string[];
	/** True when the in-range session set was cut to `MAX_TOOL_SESSIONS`. */
	capped: boolean;
}

/** Server-side filters for the tool-call detail (all optional; blank = no filter). */
export interface ToolErrorsFilter {
	/**
	 * Base row predicate: `errors` keeps the unified failed definition,
	 * `all` lists every tool content item. Absent = the default
	 * ({@link DEFAULT_TOOL_CALL_STATUS}). Not a per-row filter.
	 */
	status?: ToolCallStatus;
	/** Exact content-item `$.name`; `null`/blank = every tool. */
	tool?: string | null;
	/** Exact `session_v2.agent`; `null`/blank = every agent. */
	agent?: string | null;
	/** Case-insensitive substring of `$.state.error.message`. */
	search?: string | null;
}

/** Filters plus the page window for one detail request. */
export interface ToolErrorsQuery extends ToolErrorsFilter {
	/** Page size; clamped to `[1, MAX_ERROR_LIMIT]`, default {@link DEFAULT_ERROR_LIMIT}. */
	limit?: number;
	/** Rows to skip, newest first; clamped to `>= 0`. */
	offset?: number;
}

/** Default page size of the error detail. */
export const DEFAULT_ERROR_LIMIT = 50;
/** Hard upper bound on one page, so a client cannot request an unbounded list. */
export const MAX_ERROR_LIMIT = 200;

/** Clamp a caller-supplied page size to an integer in `[1, MAX_ERROR_LIMIT]`. */
export function clampErrorLimit(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_ERROR_LIMIT;
	return Math.min(MAX_ERROR_LIMIT, Math.max(1, Math.floor(value)));
}

/** Clamp a caller-supplied page offset to an integer `>= 0`. */
export function clampErrorOffset(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}
