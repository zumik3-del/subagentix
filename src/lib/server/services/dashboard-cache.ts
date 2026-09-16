/**
 * Short-TTL read-through cache for dashboard aggregates (dashboard Phase 2,
 * task #408).
 *
 * `session-graph.ts` caches a query projection; this module caches the panel's
 * aggregate loaders (Tier S/M/P) the same way: one cache generation per
 * `dbStateToken()`, dropped on `onSettingsChange` / `onDbReset`, bounded by an
 * LRU. On top of that it adds the two Phase 2 requirements a query projection
 * does not need: a ~30s TTL (aggregates are expensive and may be requested
 * before another writer commits) and in-flight de-duplication (a burst of
 * concurrent requests for the same key awaits one loader run).
 *
 * The API is the primitive only: the endpoint/service layer (#405) owns
 * composition and passes `refresh` from the `?refresh=1` query flag.
 *
 * Cache key = filter key (`period` + `scope`) + `dbStateToken()`, so a filter
 * is never served data computed for another filter and a DB swap or commit can
 * never reuse a stale snapshot.
 */
import type { DashboardFilter } from '../../model/dashboard';
import { dbStateToken, onDbReset } from '../db';
import { onSettingsChange } from '../settings';

/** Aggregate freshness window. Short enough to pick up live writes, long
 * enough to absorb a page's simultaneous widget requests. */
export const DASHBOARD_CACHE_TTL_MS = 30_000;

/** Bound the working set: evict the least-recently-used filter once this many
 * are cached (matching the `session-graph.ts` predecessor). */
export const DASHBOARD_CACHE_MAX_ENTRIES = 64;

interface CacheEntry {
	/** Epoch-ms the loader started; TTL runs from here. */
	startedAt: number;
	/** False while the loader is in flight (kept live even past TTL). */
	settled: boolean;
	/** Shared result; always a promise so concurrent callers can await it. */
	value: Promise<unknown>;
}

/** Options for {@link loadDashboardAggregate}. */
export interface DashboardCacheOptions {
	/** `?refresh=1`: recompute instead of serving the cached entry. */
	refresh?: boolean;
	/** Injectable clock (epoch-ms) so TTL tests stay deterministic. */
	now?: number;
}

const cache = new Map<string, CacheEntry>();
let activeToken: string | null = null;

/** Drop every cached aggregate (settings change, DB reset, tests). */
export function clearDashboardCache(): void {
	cache.clear();
	activeToken = null;
}

/** Filter portion of the cache key: `period` + `scope` (`*` = every directory). */
export function dashboardFilterKey(filter: DashboardFilter): string {
	return `${filter.period}\u0000${filter.scope ?? '*'}`;
}

/**
 * Full cache key: filter key + DB state token. Exported (and token-injectable)
 * so callers/tests can assert the invalidation contract without a live DB.
 */
export function dashboardCacheKey(filter: DashboardFilter, token = dbStateToken()): string {
	return `${dashboardFilterKey(filter)}\u0000${token}`;
}

/** Refresh recency: re-inserting moves a key to the end of Map order. */
function touch(key: string, entry: CacheEntry): void {
	cache.delete(key);
	cache.set(key, entry);
}

/**
 * Read-through cached result of `loader` for one filter. The first caller for a
 * key runs `loader`; concurrent callers share its promise. The entry is served
 * until the TTL elapses (an in-flight entry is never evicted early), then
 * recomputed. A rejected load is never cached.
 *
 * `refresh: true` (`?refresh=1`) skips the cached value and replaces it with a
 * fresh run; `now` is injectable for deterministic TTL tests.
 */
export function loadDashboardAggregate<T>(
	filter: DashboardFilter,
	loader: () => T | Promise<T>,
	options: DashboardCacheOptions = {}
): Promise<T> {
	const now = options.now ?? Date.now();
	const token = dbStateToken();
	if (token !== activeToken) {
		// A new DB generation invalidates every token-tied snapshot at once.
		cache.clear();
		activeToken = token;
	}
	const key = dashboardCacheKey(filter, token);

	if (options.refresh === true) {
		cache.delete(key);
	} else {
		const cached = cache.get(key);
		if (cached !== undefined) {
			const expired = now - cached.startedAt >= DASHBOARD_CACHE_TTL_MS;
			if (!expired || !cached.settled) {
				touch(key, cached);
				return cached.value as Promise<T>;
			}
			cache.delete(key);
		}
	}

	if (cache.size >= DASHBOARD_CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}

	// Start the loader synchronously (a throw becomes a rejection) so the entry
	// is in-flight for every concurrent caller the moment it is stored.
	let value: Promise<T>;
	try {
		value = Promise.resolve(loader());
	} catch (error) {
		value = Promise.reject(error);
	}
	const entry: CacheEntry = { startedAt: now, settled: false, value };
	entry.value.then(
		() => {
			entry.settled = true;
		},
		() => {
			// A failed load must not be cached as a value for the TTL window.
			entry.settled = true;
			if (cache.get(key) === entry) cache.delete(key);
		}
	);
	cache.set(key, entry);
	return entry.value as Promise<T>;
}

onSettingsChange(clearDashboardCache);
onDbReset(clearDashboardCache);
