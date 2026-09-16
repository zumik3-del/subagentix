/**
 * Dashboard global-filter URL state (dashboard Phase 5, task #415).
 *
 * The period + scope filter is **URL state only** (spec D6): it is parsed from
 * `?period=&scope=` on every render and written back through SvelteKit's `goto`
 * from the landing page, so deep links and back/forward reproduce the same
 * dashboard and nothing is persisted server-side. The pure parse/serialise and
 * option-building rules live here (no Svelte, DOM or `$lib/server` import) so
 * they stay unit-testable, mirroring the `picker.ts` / `top-tools.ts` split
 * (docs/ui-standards.md §10).
 */
import {
	type DashboardFilter,
	type DashboardPeriod,
	isDashboardPeriod
} from '$lib/model/dashboard';
import type { DirectorySummary } from '$lib/model/types';

/** Default window preset when the URL names no valid period (spec §2.8). */
export const DEFAULT_PERIOD: DashboardPeriod = '30d';

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
 * Parse the URL query into the validated filter. A blank/unknown `period` falls
 * back to {@link DEFAULT_PERIOD}; a blank/`all`/unknown `scope` (one not in
 * `knownScopes`) falls back to every directory. Never throws (AC-2), so a stale
 * or hand-edited deep link renders the default dashboard instead of an error.
 */
export function parseFilter(
	search: URLSearchParams,
	knownScopes: readonly string[]
): DashboardFilter {
	const periodParam = search.get('period');
	const period =
		periodParam !== null && isDashboardPeriod(periodParam) ? periodParam : DEFAULT_PERIOD;

	const scopeParam = search.get('scope');
	const scope =
		scopeParam !== null &&
		scopeParam !== '' &&
		scopeParam !== SCOPE_ALL &&
		knownScopes.includes(scopeParam)
			? scopeParam
			: null;

	return { period, scope };
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
