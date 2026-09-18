/**
 * Dashboard widget endpoint composition (dashboard Phase 1/2, task #405).
 *
 * The single place that maps a widget id + filter onto its payload. The payload
 * builder for a widget is selected straight from the id-keyed `WIDGET_BUILDERS`
 * map below (`WidgetDef.tier` in `src/lib/widgets/registry.ts` is descriptive
 * metadata only), and every load is wrapped in the short-TTL
 * `services/dashboard-cache.ts`, so the SQL and the DTO shapes stay in the
 * services (`services/dashboard*.ts`) — this module never re-implements an
 * aggregate, it only projects the service DTOs onto the whitelisted fields the
 * endpoint returns.
 *
 * Server-only: it imports the services (and therefore `bun:sqlite`), so it must
 * never reach the client bundle.
 */
import { json } from '@sveltejs/kit';
import {
	isDashboardPeriod,
	type DashboardFilter,
	type KpiData,
	type WidgetDataMap
} from '$lib/model/dashboard';
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
import { isWidgetId, type WidgetId, type WidgetSettingValues } from '$lib/widgets/registry';
import { parseWidgetSettingParams, widgetSettingSignature } from '$lib/widgets/settings';

/** The validated response envelope (AC-1). */
export interface DashboardEnvelope {
	widgetId: WidgetId;
	/** Epoch-ms the (possibly cached) payload was produced. */
	generatedAt: number;
	/** Widget-specific payload, whitelisted fields only. */
	data: unknown;
}

/** Build one widget's payload from the services; no caching here. */
type WidgetDataBuilder = (
	filter: DashboardFilter,
	now: number,
	settings: WidgetSettingValues
) => unknown;

/**
 * One payload builder per widget id, each returning its own
 * {@link WidgetDataMap} payload — the map is what pins a builder to its widget,
 * so a payload that drifts from the shared contract fails here. The third
 * `settings` argument is the widget's resolved setting map; a builder that
 * declares no settings simply omits the parameter.
 */
type WidgetBuilders = {
	[K in WidgetId]: (
		filter: DashboardFilter,
		now: number,
		settings: WidgetSettingValues
	) => WidgetDataMap[K];
};

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
 * Payload builders keyed by widget id: one entry per registered widget, each
 * returning its own {@link WidgetDataMap} payload. The `WidgetBuilders` type
 * pins every id to the payload its registry descriptor declares, so a widget
 * added to the registry without a builder is a compile error. `kpi`'s dominant
 * source is `message`; its builder additionally reads the cheap `session`
 * count. `WidgetDef.tier` stays registry metadata and is never read for
 * dispatch.
 */
const WIDGET_BUILDERS: WidgetBuilders = {
	kpi: buildKpi,
	'sessions-per-day': (filter, now) =>
		getSessionsPerDay(filter, now).map((bucket) => ({ day: bucket.day, value: bucket.value })),
	'cost-per-day': (filter, now) =>
		getCostPerDay(filter, now).map((bucket) => ({ day: bucket.day, value: bucket.value })),
	'top-tools': (filter, now, settings) => {
		const usage = getTopTools(filter, now, settings);
		return {
			capped: usage.capped,
			tools: usage.tools.map((tool) => ({
				name: tool.name,
				count: tool.count,
				errors: tool.errors,
				errorShare: tool.errorShare
			}))
		};
	},
	'agent-distribution': (filter, now) =>
		getAgentDistribution(filter, now).map((row) => ({ name: row.name, count: row.count })),
	'top-projects': (filter, now) =>
		getTopDirectories(filter, now).map((row) => ({
			directory: row.directory,
			projectName: row.projectName,
			count: row.count
		}))
};

/**
 * Resolve a widget id to its payload builder straight from the id-keyed
 * {@link WIDGET_BUILDERS} map (no tier lookup). A registered id that somehow has
 * no builder throws — a 500, never a partial response — so the map stays the one
 * dispatch source.
 */
function builderFor(widgetId: WidgetId): WidgetDataBuilder {
	const builder: WidgetDataBuilder | undefined = WIDGET_BUILDERS[widgetId];
	if (builder === undefined) {
		throw new Error(`Widget "${widgetId}" has no payload builder.`);
	}
	return builder;
}

/**
 * The shared cache keys an entry by `period` + `scope` only, so two widgets
 * requested with the same filter would collide. Namespace the cache-only key
 * with the widget id (NUL-separated, so it can never equal a real directory
 * scope); the loader still resolves the real filter from its closure, so the
 * namespace never reaches a query or a response. The widget's settings
 * signature is appended too, so two settings maps for the same widget get
 * distinct entries (a toggle is a cache miss, never stale for the TTL).
 */
function widgetCacheFilter(
	widgetId: WidgetId,
	filter: DashboardFilter,
	settings: WidgetSettingValues
): DashboardFilter {
	const signature = widgetSettingSignature(widgetId, settings);
	return {
		period: filter.period,
		scope: `${filter.scope ?? '*'}\u0000${widgetId}\u0000${signature}`
	};
}

interface CachedWidgetData {
	generatedAt: number;
	data: unknown;
}

/**
 * Load one widget's payload through the short-TTL dashboard cache. `refresh`
 * (`?refresh=1`) bypasses the TTL without clearing other widgets' entries.
 * `settings` is the widget's parsed setting map; it feeds both the builder and
 * the cache key. `now` is injectable so tests can pin the window
 * deterministically; the returned `generatedAt` is when the payload was
 * produced, not served.
 */
export function loadWidgetData(
	widgetId: WidgetId,
	filter: DashboardFilter,
	settings: WidgetSettingValues,
	refresh: boolean,
	now = Date.now()
): Promise<DashboardEnvelope> {
	const builder = builderFor(widgetId);
	return loadDashboardAggregate<CachedWidgetData>(
		widgetCacheFilter(widgetId, filter, settings),
		() => ({ generatedAt: now, data: builder(filter, now, settings) }),
		{ refresh, now }
	).then((entry) => ({ widgetId, generatedAt: entry.generatedAt, data: entry.data }));
}

/** Default window preset when `?period=` is absent/blank (spec §2.8). */
const DEFAULT_PERIOD = '30d';
/** `?scope=` value meaning "every directory" (maps to `filter.scope = null`). */
const ALL_SCOPES = 'all';

/** A validated filter, or the 400 response to return instead. */
export type DashboardFilterRequest =
	| { ok: true; filter: DashboardFilter }
	| { ok: false; response: Response };

/**
 * Validate `?period=` and `?scope=` on their own — shared by the widget
 * endpoint and the top-tools error detail endpoint, so both reject a bad filter
 * identically. A value outside the period enum or a scope that is not a known
 * directory is a 400 `{ error, field }`; a blank/absent period or scope falls
 * back to the documented defaults (`30d`, all directories) rather than
 * erroring, so an empty query string is still a valid request.
 */
export function resolveFilter(url: URL): DashboardFilterRequest {
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

	return { ok: true, filter: { period, scope } };
}

/** A validated widget request, or the 400/404 response to return instead. */
export type DashboardRequest =
	| { ok: true; widgetId: WidgetId; filter: DashboardFilter; settings: WidgetSettingValues }
	| { ok: false; response: Response };

/**
 * Validate `[widget]` on top of {@link resolveFilter}. An unknown widget id is
 * a 404; a bad period/scope is the 400 the shared filter validation returns.
 * The widget's `w.<key>=1|0` settings are parsed leniently
 * ({@link parseWidgetSettingParams}): absent/unknown params are ignored and a
 * malformed value falls back to the registry default, so a stale deep link is
 * never a 400.
 */
export function resolveDashboardRequest(widgetParam: string, url: URL): DashboardRequest {
	if (!isWidgetId(widgetParam)) {
		return {
			ok: false,
			response: json({ error: `Unknown widget "${widgetParam}".` }, { status: 404 })
		};
	}
	const resolved = resolveFilter(url);
	if (!resolved.ok) return resolved;
	return {
		ok: true,
		widgetId: widgetParam,
		filter: resolved.filter,
		settings: parseWidgetSettingParams(widgetParam, url.searchParams)
	};
}
