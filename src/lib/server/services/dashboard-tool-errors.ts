/**
 * Top-tools call-detail service (task #481; all-calls mode #484).
 *
 * Resolves the window/scope + capped session set exactly like the Tier-P
 * aggregate (`services/dashboard-tools.ts`) and applies the requested mode
 * (`errors` | `all`), the optional tool/agent/search filters and paging through
 * the query layer, so the widget's errors column and this detail's unfiltered
 * failed total describe the same rows. No caching: the detail is on-demand and
 * behind a user action.
 */
import {
	MAX_TOOL_SESSIONS,
	type DashboardFilter
} from '../../model/dashboard';
import {
	clampErrorLimit,
	clampErrorOffset,
	DEFAULT_ERROR_LIMIT,
	DEFAULT_TOOL_CALL_STATUS,
	type ToolErrorsFilter,
	type ToolErrorsPage,
	type ToolErrorsQuery
} from '../../model/tool-errors';
import { listSessionIds } from '../queries/dashboard';
import {
	countToolErrors,
	listToolErrorAgents,
	listToolErrors
} from '../queries/dashboard-tool-errors';
import { toWindow } from './dashboard';

/** Trim a filter value; blank/absent becomes "no filter" (`null`). */
function blankToNull(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? '';
	return trimmed === '' ? null : trimmed;
}

/**
 * One page of tool calls (failures only, or every call per `query.status`) for
 * the selected window/scope, plus the filtered total, the stable agent options
 * and the Tier-P `capped` flag. Only the most recent `maxSessions` in-range
 * sessions contribute (the ceiling that bounds a `period=all` `part` scan; the
 * parameter is exposed for tests).
 */
export function getToolErrors(
	filter: DashboardFilter,
	query: ToolErrorsQuery = {},
	now = Date.now(),
	maxSessions = MAX_TOOL_SESSIONS
): ToolErrorsPage {
	const window = toWindow(filter, now);
	// Ask for one more than the ceiling to tell an exact fit from a truncation.
	const ids = listSessionIds(window, maxSessions + 1);
	const capped = ids.length > maxSessions;
	const bounded = capped ? ids.slice(0, maxSessions) : ids;

	const status = query.status ?? DEFAULT_TOOL_CALL_STATUS;
	const normalized: ToolErrorsFilter = {
		status,
		tool: blankToNull(query.tool),
		agent: blankToNull(query.agent),
		search: blankToNull(query.search)
	};
	const offset = clampErrorOffset(query.offset ?? 0);
	const limit = clampErrorLimit(query.limit ?? DEFAULT_ERROR_LIMIT);

	return {
		rows: listToolErrors(bounded, normalized, offset, limit),
		total: countToolErrors(bounded, normalized),
		agents: listToolErrorAgents(bounded, status),
		capped
	};
}
