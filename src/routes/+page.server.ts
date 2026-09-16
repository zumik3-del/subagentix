import { resolveDashboardFilter, resolveDashboardWidgets } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

/**
 * Landing-page loader (dashboard Phase 3, task #404; filter preference #457).
 *
 * Reads the persisted widget selection and dashboard filter preference from
 * `settings.json` only — no opencode DB access — so `/` renders instantly and
 * can never 503 on the data layer (spec D7 / P3.1). The filter preference is
 * the fallback for `parseFilter` when the URL names no valid `?period=&scope=`,
 * so the first server render already shows the stored selection and there is
 * no default flash or hydration mismatch. Widget data is fetched per widget,
 * client-side, by the Phase 3–4 components.
 */
export const load: PageServerLoad = () => ({
	widgets: resolveDashboardWidgets(),
	filter: resolveDashboardFilter()
});
