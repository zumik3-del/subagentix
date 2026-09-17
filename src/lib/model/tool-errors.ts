/**
 * Server-free domain types for the top-tools error detail (task #481).
 *
 * Imported by the server query/service, the route handler and the client
 * `ToolErrorsModal`, so it must stay free of `$lib/server` / DB imports and of
 * any DOM/Svelte dependency. Pure and deterministic; no I/O.
 *
 * "Failed" is deliberately unified with the top-tools aggregate: a part counts
 * when `part.data.state.status` is `error` **or** `failed` (the same pair
 * `model/node.ts` uses), so the widget's errors column and this detail's
 * unfiltered total are the same number within the shared session ceiling.
 */

/** One failed tool call, flattened for the detail table. */
export interface ToolErrorEntry {
	/** `part.id`; stable row key. */
	id: string;
	/** Owning session id; the UI links to `/sessions/{sessionId}`. */
	sessionId: string;
	/** `part.time_created` (epoch-ms). */
	at: number;
	/** `session.agent`; `unknown` for a NULL/blank agent. */
	agent: string;
	/** `part.data.tool`; `unknown` for a NULL/blank tool. */
	tool: string;
	/** `part.data.state.error`; empty string when the part carries no error text. */
	error: string;
}

/**
 * The paged detail payload (`GET /api/dashboard/tool-errors`):
 * one page of failed calls plus the honest totals the filters were applied
 * against. `agents` is the stable agent option list (computed before the
 * tool/agent/search filters, so selecting an agent never collapses it).
 */
export interface ToolErrorsPage {
	/** Current page, newest first. */
	rows: ToolErrorEntry[];
	/** Rows matching every active filter (not just the current page). */
	total: number;
	/** Distinct agents in the base error set, ascending. */
	agents: string[];
	/** True when the in-range session set was cut to `MAX_TOOL_SESSIONS`. */
	capped: boolean;
}

/** Server-side filters for the error detail (all optional; blank = no filter). */
export interface ToolErrorsFilter {
	/** Exact `part.data.tool`; `null`/blank = every tool. */
	tool?: string | null;
	/** Exact `session.agent`; `null`/blank = every agent. */
	agent?: string | null;
	/** Case-insensitive substring of `part.data.state.error`. */
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
