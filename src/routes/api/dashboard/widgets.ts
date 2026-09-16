/**
 * Dashboard widget endpoint composition (dashboard Phase 1/2, task #405).
 *
 * The single place that maps a widget id + filter onto its Tier S/M/P data. The
 * payload builder for a widget is selected from `WIDGET_DEFS[].tier` in
 * `src/lib/widgets/registry.ts`, and every load is wrapped in the short-TTL
 * `services/dashboard-cache.ts`, so the SQL and the DTO shapes stay in the
 * services (`services/dashboard*.ts`) — this module never re-implements an
 * aggregate, it only projects the service DTOs onto the whitelisted fields the
 * endpoint returns.
 *
 * Server-only: it imports the services (and therefore `bun:sqlite`), so it must
 * never reach the client bundle.
 */
import { json } from '@sveltejs/kit';
import { isDashboardPeriod, type DashboardFilter } from '$lib/model/dashboard';
import type { TokenCounts } from '$lib/model/token';
import { invalidRequest } from '$lib/server/http';
import { listDirectoriesCached } from '$lib/server/queries/directories';
import { loadDashboardAggregate } from '$lib/server/services/dashboard-cache';
import {
	getAgentDistribution,
	getSessionTotals,
	getSessionsPerDay,
	getTopDirectories
} from '$lib/server/services/dashboard';
import { getCostPerDay, getMessageTotals } from '$lib/server/services/dashboard-message';
import { getTopTools } from '$lib/server/services/dashboard-tools';
import { isWidgetId, WIDGET_DEFS, type WidgetId, type WidgetTier } from '$lib/widgets/registry';

/** Windowed KPI payload: Tier-S session count + Tier-M cost/token sums. */
export interface KpiData {
	/** In-window/scope sessions (`session` rows, Tier S). */
	sessions: number;
	/** Summed `message.data.cost` (Tier M). */
	cost: number;
	/** Summed `message.data.tokens.*` (Tier M). */
	tokens: TokenCounts;
}

/** The validated response envelope (AC-1). */
export interface DashboardEnvelope {
	widgetId: WidgetId;
	/** Epoch-ms the (possibly cached) payload was produced. */
	generatedAt: number;
	/** Widget-specific payload, whitelisted fields only. */
	data: unknown;
}

/** Build one widget's payload from the services; no caching here. */
type WidgetDataBuilder = (filter: DashboardFilter, now: number) => unknown;

/** Windowed KPI: message-derived cost/tokens (Tier M) + session count (Tier S). */
function buildKpi(filter: DashboardFilter, now: number): KpiData {
	const totals = getMessageTotals(filter, now);
	return {
		sessions: getSessionTotals(filter, now).count,
		cost: totals.cost,
		tokens: {
			input: totals.tokens.input,
			output: totals.tokens.output,
			reasoning: totals.tokens.reasoning,
			cacheRead: totals.tokens.cacheRead,
			cacheWrite: totals.tokens.cacheWrite
		}
	};
}

/**
 * Payload builders grouped by the registry's dominant tier (`WidgetDef.tier`),
 * so the dispatch below is literally keyed off `WIDGET_DEFS[].tier`. `kpi` sits
 * in the M group because its dominant source is `message` (spec §2.3); its
 * builder additionally reads the cheap Tier-S session count.
 */
const TIER_BUILDERS: Record<WidgetTier, Partial<Record<WidgetId, WidgetDataBuilder>>> = {
	S: {
		'sessions-per-day': (filter, now) =>
			getSessionsPerDay(filter, now).map((bucket) => ({ day: bucket.day, value: bucket.value })),
		'agent-distribution': (filter, now) =>
			getAgentDistribution(filter, now).map((row) => ({ name: row.name, count: row.count })),
		'top-projects': (filter, now) =>
			getTopDirectories(filter, now).map((row) => ({
				directory: row.directory,
				projectName: row.projectName,
				count: row.count
			}))
	},
	M: {
		kpi: buildKpi,
		'cost-per-day': (filter, now) =>
			getCostPerDay(filter, now).map((bucket) => ({ day: bucket.day, value: bucket.value }))
	},
	P: {
		'top-tools': (filter, now) => {
			const usage = getTopTools(filter, now);
			return {
				capped: usage.capped,
				tools: usage.tools.map((tool) => ({
					name: tool.name,
					count: tool.count,
					errors: tool.errors,
					errorShare: tool.errorShare
				}))
			};
		}
	}
};

/**
 * Resolve a registered widget id to its tier payload builder via the registry,
 * so the registry stays the single source of widget identity/tier. Throws (a
 * 500, never a partial response) if a registered widget has no builder.
 */
function builderFor(widgetId: WidgetId): WidgetDataBuilder {
	const def = WIDGET_DEFS.find((candidate) => candidate.id === widgetId);
	if (def === undefined) {
		throw new Error(`Widget "${widgetId}" is not registered.`);
	}
	const builder = TIER_BUILDERS[def.tier][widgetId];
	if (builder === undefined) {
		throw new Error(`Widget "${widgetId}" has no Tier-${def.tier} payload builder.`);
	}
	return builder;
}

/**
 * The shared cache keys an entry by `period` + `scope` only, so two widgets
 * requested with the same filter would collide. Namespace the cache-only key
 * with the widget id (NUL-separated, so it can never equal a real directory
 * scope); the loader still resolves the real filter from its closure, so the
 * namespace never reaches a query or a response.
 */
function widgetCacheFilter(widgetId: WidgetId, filter: DashboardFilter): DashboardFilter {
	return { period: filter.period, scope: `${filter.scope ?? '*'}\u0000${widgetId}` };
}

interface CachedWidgetData {
	generatedAt: number;
	data: unknown;
}

/**
 * Load one widget's payload through the short-TTL dashboard cache. `refresh`
 * (`?refresh=1`) bypasses the TTL without clearing other widgets' entries.
 * `now` is injectable so tests can pin the window deterministically; the
 * returned `generatedAt` is when the payload was produced, not served.
 */
export function loadWidgetData(
	widgetId: WidgetId,
	filter: DashboardFilter,
	refresh: boolean,
	now = Date.now()
): Promise<DashboardEnvelope> {
	const builder = builderFor(widgetId);
	return loadDashboardAggregate<CachedWidgetData>(
		widgetCacheFilter(widgetId, filter),
		() => ({ generatedAt: now, data: builder(filter, now) }),
		{ refresh, now }
	).then((entry) => ({ widgetId, generatedAt: entry.generatedAt, data: entry.data }));
}

/** Default window preset when `?period=` is absent/blank (spec §2.8). */
const DEFAULT_PERIOD = '30d';
/** `?scope=` value meaning "every directory" (maps to `filter.scope = null`). */
const ALL_SCOPES = 'all';

/** A validated request, or the 400/404 response to return instead. */
export type DashboardRequest =
	| { ok: true; widgetId: WidgetId; filter: DashboardFilter }
	| { ok: false; response: Response };

/**
 * Validate `[widget]`, `?period=` and `?scope=`. An unknown widget id is a 404;
 * a value outside the period enum or a scope that is not a known directory is a
 * 400 `{ error, field }`. A blank/absent period or scope falls back to the
 * documented defaults (`30d`, all directories) rather than erroring, so an
 * empty query string is still a valid request.
 */
export function resolveDashboardRequest(widgetParam: string, url: URL): DashboardRequest {
	if (!isWidgetId(widgetParam)) {
		return {
			ok: false,
			response: json({ error: `Unknown widget "${widgetParam}".` }, { status: 404 })
		};
	}

	const periodParam = url.searchParams.get('period');
	const period = periodParam === null || periodParam === '' ? DEFAULT_PERIOD : periodParam;
	if (!isDashboardPeriod(period)) {
		return {
			ok: false,
			response: invalidRequest(`Unknown period "${periodParam ?? ''}".`, 'period')
		};
	}

	const scopeParam = url.searchParams.get('scope');
	let scope: string | null = null;
	if (scopeParam !== null && scopeParam !== '' && scopeParam !== ALL_SCOPES) {
		// The scope options are exactly the sidebar directories (spec §2.6); a
		// value the UI could not have produced is a client error, not empty data.
		// The list is memoized per `dbStateToken()` (`queries/directories.ts`), so
		// a page's six widget requests share one directory query instead of six.
		const known = listDirectoriesCached().some((entry) => entry.directory === scopeParam);
		if (!known) {
			return { ok: false, response: invalidRequest(`Unknown scope "${scopeParam}".`, 'scope') };
		}
		scope = scopeParam;
	}

	return { ok: true, widgetId: widgetParam, filter: { period, scope } };
}
