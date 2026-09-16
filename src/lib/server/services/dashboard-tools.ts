/**
 * Tier-P dashboard aggregate service (dashboard Phase 2, task #407).
 *
 * The `part`-derived half of the dashboard service: top tools by call count with
 * their error share. It resolves the in-range session ids (Tier S) under a hard
 * session ceiling ({@link MAX_TOOL_SESSIONS}) so a `period=all` request cannot
 * trigger an unbounded `part` scan, then delegates the grouped read to
 * `queries/dashboard.ts` (chunked `IN`, merged in JS) and maps it to the DTO.
 * Split out of `services/dashboard.ts` to keep the tiers in their own modules;
 * it reuses that module's {@link toWindow} so window/scope resolution is defined
 * once. No caching here: the memoized dashboard cache wraps these loaders.
 */
import {
	MAX_TOOL_SESSIONS,
	type DashboardFilter,
	type ToolUsage,
	type ToolUsageEntry
} from '../../model/dashboard';
import { aggregateToolUsage, DEFAULT_TOP_N, listSessionIds } from '../queries/dashboard';
import { toWindow } from './dashboard';

/**
 * Top tools (count desc, name asc) with error share for the selected
 * window/scope. Only the most recent `maxSessions` in-range sessions contribute
 * (the ceiling that bounds a `period=all` `part` scan; the parameter is exposed
 * for tests). `capped` is the flag the widget uses to label the all-time view as
 * approximate.
 */
export function getTopTools(
	filter: DashboardFilter,
	now = Date.now(),
	limit = DEFAULT_TOP_N,
	maxSessions = MAX_TOOL_SESSIONS
): ToolUsage {
	const window = toWindow(filter, now);
	// Ask for one more than the ceiling to tell an exact fit from a truncation.
	const ids = listSessionIds(window, maxSessions + 1);
	const capped = ids.length > maxSessions;
	const tools: ToolUsageEntry[] = aggregateToolUsage(
		capped ? ids.slice(0, maxSessions) : ids,
		limit
	).map((row) => ({
		name: row.name,
		count: row.count,
		errors: row.errors,
		errorShare: row.count > 0 ? row.errors / row.count : 0
	}));
	return { tools, capped };
}
