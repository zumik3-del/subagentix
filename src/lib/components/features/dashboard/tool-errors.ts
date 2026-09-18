/**
 * Pure view logic for the top-tools call detail (task #481; all-calls mode
 * #484).
 *
 * Kept out of `ToolErrorsModal.svelte` so the request-URL mapping and the
 * page-append rule are testable without a renderer or a DOM, mirroring the
 * `top-tools.ts` split. No DOM, no Svelte and no `$lib/server` import.
 */
import type { DashboardPeriod } from '$lib/model/dashboard';
import type { ToolCallStatus, ToolErrorEntry, ToolErrorsPage } from '$lib/model/tool-errors';
import { SCOPE_ALL } from './filter';

/** Endpoint backing the detail table. */
export const TOOL_ERRORS_ENDPOINT = '/api/dashboard/tool-errors';

/** The editable filter state the detail panel sends to the server. */
export interface ToolErrorViewFilters {
	/** Mode: `errors` = failed only, `all` = every call; sent as `?status=`. */
	status: ToolCallStatus;
	/** Exact tool name; blank = every tool. */
	tool: string;
	/** Window preset, sent as `?period=`. */
	period: DashboardPeriod;
	/** Directory scope, sent as `?scope=` (`null` -> `all`). */
	scope: string | null;
	/** Exact agent; blank = every agent. */
	agent: string;
	/** Error-text search; blank = no search. */
	search: string;
}

/**
 * Build the detail request URL. Every filter is server-side: the status is
 * always sent explicitly, the tool/agent values are only sent when present, the
 * search travels as `?q=` and both the page size and offset are always
 * explicit. `URLSearchParams` does the percent-encoding, so a tool name or
 * search term with spaces/`&`/`%` is safe.
 */
export function buildToolErrorsUrl(
	filters: ToolErrorViewFilters,
	limit: number,
	offset: number
): string {
	const params = new URLSearchParams({
		status: filters.status,
		period: filters.period,
		scope: filters.scope ?? SCOPE_ALL,
		limit: String(limit),
		offset: String(offset)
	});
	const tool = filters.tool.trim();
	if (tool !== '') params.set('tool', tool);
	const agent = filters.agent.trim();
	if (agent !== '') params.set('agent', agent);
	const search = filters.search.trim();
	if (search !== '') params.set('q', search);
	return `${TOOL_ERRORS_ENDPOINT}?${params.toString()}`;
}

/** Append a freshly loaded page to the rows already on screen (newest last). */
export function appendToolErrorRows(
	existing: readonly ToolErrorEntry[],
	page: Pick<ToolErrorsPage, 'rows'>
): ToolErrorEntry[] {
	return [...existing, ...page.rows];
}
