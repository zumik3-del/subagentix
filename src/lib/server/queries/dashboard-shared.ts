/**
 * Shared types, constants and helpers for the dashboard query modules.
 *
 * The Tier-S / Tier-M / Tier-P aggregates live in `dashboard-sessions.ts`,
 * `dashboard-message.ts` and `dashboard-tools.ts`; this module holds what they
 * all reuse — the window/scope shape, the top-N and `IN`-chunk constants, and
 * the row coercions/chunker — so none of them is duplicated per tier. The
 * public entry point stays `dashboard.ts`, which re-exports the tier modules.
 */

/** The window/scope a Tier-S aggregate is computed over. */
export interface DashboardWindow {
	/** Inclusive lower bound (epoch-ms); `null`/absent = unbounded. */
	from?: number | null;
	/** Exclusive upper bound (epoch-ms); `null`/absent = unbounded. */
	to?: number | null;
	/** Directory scope; `null`/absent/blank = every directory. */
	directory?: string | null;
}

/** Rows returned when a grouped loader is called without an explicit limit. */
export const DEFAULT_TOP_N = 10;
/** Hard upper bound on a grouped loader, so a caller cannot request a huge list. */
const MAX_TOP_N = 100;

/** Label used for a NULL/blank group key, matching `SessionSummary.agent`. */
export const UNKNOWN_LABEL = 'unknown';

/**
 * Maximum number of ids bound into one `IN (?, …)` clause. SQLite's default
 * `SQLITE_MAX_VARIABLE_NUMBER` has historically been 999, so a `period=all`
 * id set (currently ~1.6k sessions and growing) must be split; 500 keeps a
 * comfortable margin for the accompanying window bindings.
 */
export const IN_CHUNK_SIZE = 500;

export function isBound(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** Clamp a caller-supplied top-N to a safe integer within `[0, MAX_TOP_N]`. */
export function sanitizeLimit(limit: number): number {
	if (!Number.isFinite(limit)) return 0;
	return Math.min(MAX_TOP_N, Math.max(0, Math.floor(limit)));
}

export function toCount(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

export function toText(value: unknown): string {
	if (typeof value === 'string') return value;
	return value === null || value === undefined ? '' : String(value);
}

/** Split `values` into consecutive chunks of at most `size` (never empty). */
export function chunk<T>(values: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}
