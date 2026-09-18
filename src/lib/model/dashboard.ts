/**
 * Server-free dashboard domain types (dashboard Phase 1, task #403).
 *
 * Imported by the server aggregate service, the widget API routes and the
 * client widgets, so it must stay free of `$lib/server` / DB imports and of any
 * DOM/Svelte dependency. Pure and deterministic; no I/O.
 */
import { utcDayStart, type DayBucket } from './chart';
import type { TokenCounts } from './token';
import type { WidgetId } from '$lib/widgets/registry';

/**
 * Fixed period presets (spec §2.2); `all` is unbounded history and `today` is
 * the current UTC calendar day rather than a rolling window.
 */
export type DashboardPeriod = 'all' | 'today' | '3d' | '7d' | '30d' | '90d';

/** Every valid period, in selector order (newest window first after `all`). */
export const DASHBOARD_PERIODS: readonly DashboardPeriod[] = [
	'all',
	'today',
	'3d',
	'7d',
	'30d',
	'90d'
];

/**
 * Length of a preset window in whole days. `null` for the presets that are not a
 * rolling day count: `all` (unbounded history) and `today` (the current UTC
 * calendar day, resolved by {@link resolveTimeWindow}).
 */
export function periodDays(period: DashboardPeriod): number | null {
	switch (period) {
		case '3d':
			return 3;
		case '7d':
			return 7;
		case '30d':
			return 30;
		case '90d':
			return 90;
		default:
			return null;
	}
}

/** Type guard for untrusted input (URL query, API payloads). */
export function isDashboardPeriod(value: unknown): value is DashboardPeriod {
	return typeof value === 'string' && (DASHBOARD_PERIODS as readonly string[]).includes(value);
}

/** The single global filter applied to every dashboard widget. */
export interface DashboardFilter {
	/** Window preset. */
	period: DashboardPeriod;
	/** Directory scope; `null` = every directory. */
	scope: string | null;
}

/**
 * A half-open epoch-ms window `[from, to)`; a `null` bound is unbounded. The
 * server aggregates by **UTC** calendar day (spec D9) so rendered buckets are
 * identical across server timezones and match `model/chart.ts` bucketing.
 */
export interface TimeWindow {
	from: number | null;
	to: number | null;
}

const DAY_MS = 86_400_000;

/**
 * Resolve a period preset to its window relative to `now` (epoch-ms). `all`
 * stays unbounded; a non-finite `now` also degrades to unbounded rather than
 * producing a meaningless range.
 *
 * `today` is the one calendar-aligned preset — `[start of the current UTC day,
 * now)` — so its chart shows a single current-day bucket instead of a rolling
 * span that straddles two. At exactly `00:00:00.000Z` the window is empty
 * (`from === to`), never negative.
 */
export function resolveTimeWindow(period: DashboardPeriod, now: number): TimeWindow {
	if (!Number.isFinite(now)) return { from: null, to: null };
	if (period === 'today') return { from: utcDayStart(now), to: now };
	const days = periodDays(period);
	if (days === null) return { from: null, to: null };
	return { from: now - days * DAY_MS, to: now };
}

/** One named aggregate row (agent, model, provider or directory count). */
export interface DistributionEntry {
	/** Display label; `unknown` for a NULL/blank group. */
	name: string;
	/** Matching sessions in the window/scope. */
	count: number;
}

/** Model and provider distributions for the same window (one group each). */
export interface ModelProviderDistribution {
	models: DistributionEntry[];
	providers: DistributionEntry[];
}

/** One row of the top-directories (top-projects) widget. */
export interface TopDirectoryEntry {
	/** Absolute directory path. */
	directory: string;
	/** opencode project name for the directory, or `null` when unlinked. */
	projectName: string | null;
	/** Sessions recorded in the directory within the window/scope. */
	count: number;
}

/** Windowed session totals from the `session` rollup columns. */
export interface DashboardTotals {
	/** Matching session rows. */
	count: number;
	/** Sum of `session.cost` (gross). */
	cost: number;
	/** Sum of the five `session.tokens_*` columns. */
	tokens: TokenCounts;
}

/**
 * Windowed message-derived usage totals (dashboard Phase 2, Tier M): gross
 * `message.data.cost` and the five `message.data.tokens.*` categories summed
 * over messages in the window. Unlike {@link DashboardTotals} there is no
 * session count — Tier M measures spend/work, not rows, and the KPI widget
 * pairs it with the Tier-S session counts.
 */
export interface MessageUsageTotals {
	/** Sum of `message.data.cost` (gross). */
	cost: number;
	/** Sum of the five `message.data.tokens.*` categories. */
	tokens: TokenCounts;
}

/**
 * Windowed KPI payload: the Tier-S session count paired with the Tier-M
 * cost/token sums. Replaces the two private copies that used to live in the
 * server builder and in `KpiWidget.svelte` (task #488).
 */
export interface KpiData {
	/** In-window/scope sessions (`session` rows, Tier S). */
	sessions: number;
	/** Summed `message.data.cost` (Tier M). */
	cost: number;
	/** Summed `message.data.tokens.*` (Tier M). */
	tokens: TokenCounts;
}

/**
 * Hard ceiling on the sessions a Tier-P (top-tools) read may scan. `period=all`
 * has no time bound, and `part` has no time/tool index, so without a ceiling the
 * scan would grow without limit with history (~285k rows today, one row per tool
 * call; spec R1). A Tier-P read contributes only the most recent
 * `MAX_TOOL_SESSIONS` sessions and flags the result as capped, so the widget can
 * label the all-time view as approximate. Bounded periods rarely reach the
 * ceiling; it applies to every Tier-P read as a safety bound.
 */
export const MAX_TOOL_SESSIONS = 2_000;

/** One row of the top-tools (Tier P) widget. */
export interface ToolUsageEntry {
	/** Tool name (`part.data.tool`); `unknown` for a NULL/blank tool. */
	name: string;
	/** Matching `part` rows in the capped window/scope. */
	count: number;
	/** Of `count`, tool parts whose `state.status` is `error`. */
	errors: number;
	/** `errors / count` in `[0, 1]`; `0` when `count` is `0`. */
	errorShare: number;
}

/** Tier-P top-tools payload: the capped rows plus whether the ceiling cut them. */
export interface ToolUsage {
	/** Top-N tools, count desc then name asc. */
	tools: ToolUsageEntry[];
	/** True when the in-range session set was cut to {@link MAX_TOOL_SESSIONS}. */
	capped: boolean;
}

/**
 * Widget id -> `/api/dashboard/<id>` payload type — the single client-safe
 * source of truth shared by the server payload builders
 * (`routes/api/dashboard/widgets.ts`) and the widget bodies (task #488).
 *
 * Keyed by {@link WidgetId}, so the mapped type refuses to compile when a
 * registered widget id has no payload entry here (the indexed access fails),
 * keeping the map exhaustive over the widget set.
 */
export type WidgetDataMap = {
	[K in WidgetId]: {
		/** KPI tiles + token mix (Tier S/M). */
		kpi: KpiData;
		/** Dense UTC-day session counts (Tier S). */
		'sessions-per-day': DayBucket[];
		/** Dense UTC-day cost sums (Tier M). */
		'cost-per-day': DayBucket[];
		/** Capped top-tools rows (Tier P). */
		'top-tools': ToolUsage;
		/** Ranked agent distribution (Tier S). */
		'agent-distribution': DistributionEntry[];
		/** Ranked directory distribution (Tier S). */
		'top-projects': TopDirectoryEntry[];
	}[K];
};
