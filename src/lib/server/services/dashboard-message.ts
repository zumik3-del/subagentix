/**
 * Tier-M dashboard aggregate service (dashboard Phase 2, task #406).
 *
 * The `message`-derived half of the dashboard service: cost/day, tokens/day
 * and windowed KPI totals, all bucketed by the same UTC day rule as the Tier-S
 * series (`model/chart.ts`). Split out of `services/dashboard.ts` to stay under
 * the service 150-line target; it reuses that module's {@link toWindow} so the
 * window/scope resolution is defined once.
 *
 * Each call resolves the in-window session ids (Tier S) and hands them to the
 * query layer, which chunks the `IN (session_ids)` list below SQLite's
 * variable limit. No caching here: the memoized dashboard cache wraps these
 * loaders.
 */
import { bucketByUtcDay, type DayBucket } from '../../model/chart';
import type { DashboardFilter, MessageUsageTotals } from '../../model/dashboard';
import { total, type TokenCounts } from '../../model/token';
import {
	aggregateMessageUsageByUtcDay,
	listSessionIds,
	type DashboardWindow,
	type MessageDayRecord
} from '../queries/dashboard';
import { toWindow } from './dashboard';

/**
 * Raw Tier-M day records for one resolved window: resolve the in-window session
 * ids (Tier S), then aggregate their `message` rows by UTC day with the query
 * layer's chunked `IN` list.
 *
 * `listSessionIds(window)` is deliberately UNCAPPED (no `max`): cost/day and
 * token/day must be exact, so every in-window session is scanned — unlike the
 * Tier-P tool usage, which caps to the most recent sessions to stay bounded.
 * The cost is exact-by-design, not unbounded: it is the `message` rows of the
 * in-window session set, chunked under SQLite's variable limit by the query
 * layer, and the dashboard cache absorbs repeated requests for the same filter.
 */
function messageDays(window: DashboardWindow): MessageDayRecord[] {
	return aggregateMessageUsageByUtcDay(listSessionIds(window), window);
}

/** Dense UTC-day gross cost from `message` timestamps, gaps filled with 0. */
export function getCostPerDay(filter: DashboardFilter, now = Date.now()): DayBucket[] {
	const window = toWindow(filter, now);
	const points = messageDays(window).map((row) => ({
		at: Date.parse(`${row.day}T00:00:00.000Z`),
		value: row.cost
	}));
	return bucketByUtcDay(points, window.from ?? undefined, window.to ?? undefined);
}

/**
 * Dense UTC-day total tokens (all five categories) from `message` timestamps,
 * gaps filled with 0.
 */
export function getTokensPerDay(filter: DashboardFilter, now = Date.now()): DayBucket[] {
	const window = toWindow(filter, now);
	const points = messageDays(window).map((row) => ({
		at: Date.parse(`${row.day}T00:00:00.000Z`),
		value: total(row.tokens)
	}));
	return bucketByUtcDay(points, window.from ?? undefined, window.to ?? undefined);
}

/**
 * Windowed message usage totals: gross cost and the summed token categories,
 * for the KPI widget. Equal to summing {@link getCostPerDay} /
 * {@link getTokensPerDay} without the densification step.
 */
export function getMessageTotals(filter: DashboardFilter, now = Date.now()): MessageUsageTotals {
	const tokens: TokenCounts = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
	let cost = 0;
	for (const row of messageDays(toWindow(filter, now))) {
		cost += row.cost;
		tokens.input += row.tokens.input;
		tokens.output += row.tokens.output;
		tokens.reasoning += row.tokens.reasoning;
		tokens.cacheRead += row.tokens.cacheRead;
		tokens.cacheWrite += row.tokens.cacheWrite;
	}
	return { cost, tokens };
}
