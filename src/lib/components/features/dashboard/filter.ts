/**
 * Dashboard global-filter state (dashboard Phase 5, task #415; persisted #457).
 *
 * The period + scope filter lives in `?period=&scope=`: it is parsed from the
 * URL on every render and written back through SvelteKit's `goto` from the
 * landing page, so deep links and back/forward reproduce the same dashboard.
 * Since task #457 a manual selector change is *also* saved server-side (the
 * settings store's `dashboardFilter`) and supplied to {@link parseFilter} as
 * the fallback, so precedence is URL > stored preference > hardcoded default.
 * The pure parse/serialise and option-building rules live here (no Svelte, DOM
 * or `$lib/server` import) so they stay unit-testable, mirroring the
 * `picker.ts` / `top-tools.ts` split (docs/ui-standards.md §10).
 */
import {
	type DashboardFilter,
	type DashboardPeriod,
	isDashboardPeriod
} from '$lib/model/dashboard';
import type { DirectorySummary } from '$lib/model/types';

/** Default window preset when neither the URL nor the preference names one. */
export const DEFAULT_PERIOD: DashboardPeriod = '7d';

/**
 * The one definition of the first-visit default: `Last 7 days` + every
 * directory. Reused by the settings store (`resolveDashboardFilter`) and by the
 * components that render standalone, so the default never drifts.
 */
export const DEFAULT_FILTER: DashboardFilter = { period: DEFAULT_PERIOD, scope: null };

/** `?scope=` value meaning "every directory" (the API maps it back to `null`). */
export const SCOPE_ALL = 'all';

/** One option of the period/scope selector. */
export interface FilterOption {
	/** Query value written to the URL. */
	value: string;
	/** Visible English label. */
	label: string;
}

/** One period option, keyed by the preset it selects. */
export type PeriodOption = FilterOption & { value: DashboardPeriod };

/** English labels for every preset; the `Record` fails to compile if one is missed. */
const PERIOD_LABELS: Record<DashboardPeriod, string> = {
	today: 'Today',
	'3d': 'Last 3 days',
	'7d': 'Last 7 days',
	'30d': 'Last 30 days',
	'90d': 'Last 90 days',
	all: 'All time'
};

/**
 * Selector order per spec §2.8 (`today | 3d | 7d | 30d | 90d | all`), unlike
 * `DASHBOARD_PERIODS` (the enum order used for validation). The two shortest
 * windows lead so the most recent view is one click away.
 */
const PERIOD_ORDER: readonly DashboardPeriod[] = ['today', '3d', '7d', '30d', '90d', 'all'];

/** Period chooser options, in selector order, each with its English label. */
export const PERIOD_OPTIONS: readonly PeriodOption[] = PERIOD_ORDER.map((value) => ({
	value,
	label: PERIOD_LABELS[value]
}));

/** The always-present "every directory" scope option. */
export const ALL_SCOPE_OPTION: FilterOption = { value: SCOPE_ALL, label: 'All projects' };

/**
 * Scope chooser options from the sidebar directories (spec §2.6): project name
 * preferred, else the raw path. The `All projects` entry is not included; the
 * selector prepends {@link ALL_SCOPE_OPTION}.
 */
export function directoryOptions(directories: readonly DirectorySummary[]): FilterOption[] {
	return directories.map((entry) => ({
		value: entry.directory,
		label: entry.projectName ?? entry.directory
	}));
}

/**
 * Drop a scope that names no known directory down to every directory: a stored
 * value pointing at a deleted directory can never resurrect as a filter.
 */
function knownScopeOrNull(
	scope: string | null | undefined,
	knownScopes: readonly string[]
): string | null {
	return scope !== null &&
		scope !== undefined &&
		scope !== '' &&
		scope !== SCOPE_ALL &&
		knownScopes.includes(scope)
		? scope
		: null;
}

/**
 * Parse the URL query into the validated filter, falling back to the stored
 * preference and then to {@link DEFAULT_FILTER}. A valid `?period=` wins; an
 * invalid/absent one uses the stored period (already validated by the settings
 * store) and, last, {@link DEFAULT_PERIOD}. A valid directory `?scope=` (or the
 * explicit `all`/blank sentinel) wins; an absent/unknown one uses the stored
 * scope, which is itself dropped to every directory when it is not in
 * `knownScopes`. Never throws (AC-2), so a stale or hand-edited deep link
 * renders a valid dashboard instead of an error. `stored` is optional so the
 * original 2-argument callers keep the hardcoded-default behaviour.
 */
export function parseFilter(
	search: URLSearchParams,
	knownScopes: readonly string[],
	stored: DashboardFilter | null = null
): DashboardFilter {
	const periodParam = search.get('period');
	const period = isDashboardPeriod(periodParam)
		? periodParam
		: stored !== null && isDashboardPeriod(stored.period)
			? stored.period
			: DEFAULT_PERIOD;

	const scopeParam = search.get('scope');
	// A present-and-valid URL scope is authoritative. An explicit `all`/blank
	// sentinel also wins (every directory), so `?scope=all` is not overridden by
	// a stored preference. Only an absent or unknown URL scope falls back.
	if (scopeParam !== null && scopeParam !== '' && scopeParam !== SCOPE_ALL) {
		const known = knownScopes.includes(scopeParam);
		if (known) return { period, scope: scopeParam };
		return { period, scope: knownScopeOrNull(stored?.scope, knownScopes) };
	}
	if (scopeParam !== null) return { period, scope: null };
	return { period, scope: knownScopeOrNull(stored?.scope, knownScopes) };
}

/**
 * Serialise the filter back to the query string. Both parameters are always
 * written (every-directory as `scope=all`) so the URL is self-describing; the
 * server treats the explicit default identically to an absent value.
 */
export function filterSearch(filter: DashboardFilter): URLSearchParams {
	return new URLSearchParams({
		period: filter.period,
		scope: filter.scope ?? SCOPE_ALL
	});
}
