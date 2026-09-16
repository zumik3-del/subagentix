/**
 * Read-through cache for the per-root session graph: the subtree rows plus the
 * subtree-wide delegation edges (task #386).
 *
 * Both are read-only projections computed from one `dbStateToken()`, which
 * folds in the resolved DB path, the DB/`-wal` file state, SQLite's
 * `data_version` (flips on commits by another connection, so live WAL writes
 * invalidate) and the connection generation. The cache is additionally dropped
 * on `onSettingsChange` and `onDbReset`, so a cached graph is never older than
 * the token that produced it and never survives a DB swap.
 *
 * Returns are shared instances: callers must treat `subtree`/`edges` as
 * read-only (the services only filter/map them into fresh DTOs).
 */
import { dbStateToken, onDbReset } from '../db';
import type { DelegationRecord } from '../schema';
import { onSettingsChange } from '../settings';
import {
	getSessionSubtree,
	getSubtreeDelegationEdges,
	type SessionSubtreeRecord
} from './sessions';

export interface SessionGraph {
	subtree: SessionSubtreeRecord[];
	/** Every delegation edge in the subtree, ordered by session then time. */
	edges: DelegationRecord[];
}

/** Bound the working set: evict the oldest root once this many are cached. */
const MAX_ENTRIES = 64;

const cache = new Map<string, SessionGraph>();
let activeToken: string | null = null;

/** Drop every cached graph (settings change, DB reset, tests). */
export function clearSessionGraphCache(): void {
	cache.clear();
	activeToken = null;
}

/**
 * Cached `{ subtree, edges }` for one root. Recomputed only when the DB state
 * token changes; a token change clears every other root's entry too, so stale
 * snapshots cannot accumulate, and the map stays bounded by {@link MAX_ENTRIES}
 * while the token is stable.
 */
export function loadSessionGraph(rootId: string): SessionGraph {
	const token = dbStateToken();
	if (token !== activeToken) {
		cache.clear();
		activeToken = token;
	}
	const cached = cache.get(rootId);
	if (cached !== undefined) return cached;

	if (cache.size >= MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	const graph: SessionGraph = {
		subtree: getSessionSubtree(rootId),
		edges: getSubtreeDelegationEdges(rootId)
	};
	cache.set(rootId, graph);
	return graph;
}

onSettingsChange(clearSessionGraphCache);
onDbReset(clearSessionGraphCache);
