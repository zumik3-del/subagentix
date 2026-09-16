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
 * Dense, ascending UTC-day session counts for the window, missing days filled
 * with 0. `now` is injectable so callers/tests pin the window deterministically.
 */
export function getSessionsPerDay(filter: DashboardFilter, now = Date.now()): DayBucket[] {
	const window = toWindow(filter, now);
	const rows = countSessionsByUtcDay(window);
	const points = rows.map((row) => ({
		at: Date.parse(`${row.day}T00:00:00.000Z`),
		value: row.count
	}));
	return bucketByUtcDay(points, window.from ?? undefined, window.to ?? undefined);
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
