/**
 * Read-through cache for the sidebar directory list (task #434, review #419).
 *
 * The dashboard widget endpoint validates a requested `?scope=` against the
 * live directory set, once per widget request (6 default widgets per page
 * load). Querying `listDirectories()` directly would repeat the same `session`
 * GROUP BY six times per render, so this module memoizes the list per
 * `dbStateToken()` — the same invalidation discipline as
 * `queries/session-graph.ts` and `services/dashboard-cache.ts`: a DB swap, a
 * commit by the live writer, a settings change or an explicit reset changes the
 * token (or fires a clear hook), so a stale directory set is never validated
 * against.
 *
 * Returns the shared array instance; callers must treat it as read-only.
 */
import type { DirectorySummary } from '../../model/types';
import { dbStateToken, onDbReset } from '../db';
import { onSettingsChange } from '../settings';
import { listDirectories } from './sessions';

let activeToken: string | null = null;
let cached: DirectorySummary[] = [];

/** Drop the cached directory list (settings change, DB reset, tests). */
export function clearDirectoriesCache(): void {
	activeToken = null;
	cached = [];
}

/**
 * Cached `listDirectories()` result for the current `dbStateToken()`. Recomputed
 * only when the token changes; the shared instance is returned on a hit.
 */
export function listDirectoriesCached(): DirectorySummary[] {
	const token = dbStateToken();
	if (token === activeToken) return cached;
	cached = listDirectories();
	activeToken = token;
	return cached;
}

onSettingsChange(clearDirectoriesCache);
onDbReset(clearDirectoriesCache);
