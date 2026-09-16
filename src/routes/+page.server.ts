import { resolveDashboardWidgets } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

/**
 * Landing-page loader (dashboard Phase 3, task #404).
 *
 * Reads the persisted widget selection from `settings.json` only — no opencode
 * DB access — so `/` renders instantly and can never 503 on the data layer
 * (spec D7 / P3.1). Widget data is fetched per widget, client-side, by the
 * Phase 3–4 components.
 */
export const load: PageServerLoad = () => ({
	widgets: resolveDashboardWidgets()
});
