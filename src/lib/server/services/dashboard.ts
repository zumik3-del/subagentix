/**
 * Tier-S dashboard aggregate service (dashboard Phase 1, task #403).
 *
 * Assembles the Tier-S query records into the server-free DTOs the widget API
 * returns. It resolves the period to a window and densifies the day series with
 * `model/chart.ts`, so JSON, chart and tests share one bucket boundary rule
 * (UTC, spec D9). The Tier-M (message-day) loaders live in
 * `services/dashboard-message.ts` and reuse {@link toWindow}; no caching here:
 * Phase 2 wraps these loaders in the memoized dashboard cache.
 */
import { bucketByUtcDay, type DayBucket } from '../../model/chart';
import {
	resolveTimeWindow,
	type DashboardFilter,
	type DashboardTotals,
	type DistributionEntry,
	type ModelProviderDistribution,
	type TopDirectoryEntry
} from '../../model/dashboard';
import {
	aggregateSessionTotals,
	countSessionsByAgent,
	countSessionsByDirectory,
	countSessionsByModel,
	countSessionsByProvider,
	countSessionsByUtcDay,
	DEFAULT_TOP_N,
	listSessionIds,
	type DashboardWindow,
	type NamedCountRecord
} from '../queries/dashboard';

/** Resolve the filter's period to a query window relative to `now`. */
export function toWindow(filter: DashboardFilter, now: number): DashboardWindow {
	const { from, to } = resolveTimeWindow(filter.period, now);
	return { from, to, directory: filter.scope };
}

function toDistribution(rows: NamedCountRecord[]): DistributionEntry[] {
	return rows.map((row) => ({ name: row.name, count: row.count }));
}

/**
 * Dense UTC-day series for rows keyed by `day` (missing days filled with 0).
 * `valueOf` selects the mapped value per row; `window` bounds the bucket range,
 * so a bounded period always renders the same span as the other widgets (spec
 * D9). Shared by the Tier-S and Tier-M day loaders.
 */
export function daySeries<T extends { day: string }>(
	records: readonly T[],
	valueOf: (record: T) => number,
	window: DashboardWindow
): DayBucket[] {
	const points = records.map((row) => ({
		at: Date.parse(`${row.day}T00:00:00.000Z`),
		value: valueOf(row)
	}));
	return bucketByUtcDay(points, window.from ?? undefined, window.to ?? undefined);
}

/**
 * The most recent in-window sessions under a hard ceiling, plus whether the
 * ceiling cut them. Asks for one more than `maxSessions` to tell an exact fit
 * from a truncation, so `capped` is false exactly when every in-range session
 * survived. Shared by the Tier-P aggregate and the tool-error detail, which
 * must describe the same bounded session set.
 */
export function cappedSessionIds(
	window: DashboardWindow,
	maxSessions: number
): { ids: string[]; capped: boolean } {
	const ids = listSessionIds(window, maxSessions + 1);
	const capped = ids.length > maxSessions;
	return { ids: capped ? ids.slice(0, maxSessions) : ids, capped };
}

/**
 * Dense, ascending UTC-day session counts for the window, missing days filled
 * with 0. `now` is injectable so callers/tests pin the window deterministically.
 */
export function getSessionsPerDay(filter: DashboardFilter, now = Date.now()): DayBucket[] {
	const window = toWindow(filter, now);
	return daySeries(countSessionsByUtcDay(window), (row) => row.count, window);
}

/** Agent distribution (session count per `session.agent`), count desc, top-N. */
export function getAgentDistribution(
	filter: DashboardFilter,
	now = Date.now()
): DistributionEntry[] {
	return toDistribution(countSessionsByAgent(toWindow(filter, now)));
}

/** Model and provider distributions from the same window (`session.model` JSON). */
export function getModelProviderDistribution(
	filter: DashboardFilter,
	now = Date.now()
): ModelProviderDistribution {
	const window = toWindow(filter, now);
	return {
		models: toDistribution(countSessionsByModel(window)),
		providers: toDistribution(countSessionsByProvider(window))
	};
}

/** Directories by session count (top-projects), each with its project name. */
export function getTopDirectories(
	filter: DashboardFilter,
	now = Date.now(),
	limit = DEFAULT_TOP_N
): TopDirectoryEntry[] {
	return countSessionsByDirectory(toWindow(filter, now), limit).map((row) => ({
		directory: row.directory,
		projectName: row.projectName,
		count: row.count
	}));
}

/** Windowed session totals: row count, gross cost and summed token categories. */
export function getSessionTotals(filter: DashboardFilter, now = Date.now()): DashboardTotals {
	const record = aggregateSessionTotals(toWindow(filter, now));
	return { count: record.count, cost: record.cost, tokens: record.tokens };
}
