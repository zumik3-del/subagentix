/**
 * Pure chart math for the dashboard widgets (dashboard Phase 1, task #402).
 *
 * No DOM, no Svelte and no chart-library import: this module is safe in SSR, in
 * the client bundle and in `bun test`, mirroring `model/gantt.ts`. Every
 * function is deterministic and side-effect free, so the scales, ticks, buckets
 * and top-N truncation are testable without a renderer.
 */

// --- Linear scale -------------------------------------------------------------

/**
 * A linear mapping from a numeric domain onto a pixel range. Callable like a
 * function; `domain`/`range` expose the sanitised values actually used.
 */
export interface LinearScale {
	(value: number): number;
	/** Finite domain `[min, max]` actually used. */
	readonly domain: readonly [number, number];
	/** Finite range `[start, end]` actually used. */
	readonly range: readonly [number, number];
}

function finite(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}

/**
 * Build a linear scale. Degenerate inputs never produce NaN geometry: a
 * non-finite bound falls back to a finite one, and a zero-width domain maps
 * every input to `range[0]` (a flat line/baseline).
 */
export function linearScale(
	domain: readonly [number, number],
	range: readonly [number, number]
): LinearScale {
	const d0 = finite(domain[0], 0);
	const d1 = finite(domain[1], d0);
	const r0 = finite(range[0], 0);
	const r1 = finite(range[1], r0);
	const span = d1 - d0;
	const scale = (value: number): number => {
		if (!Number.isFinite(value) || span === 0) return r0;
		return r0 + ((value - d0) / span) * (r1 - r0);
	};
	return Object.assign(scale, {
		domain: [d0, d1] as const,
		range: [r0, r1] as const
	});
}

// --- Nice ticks ---------------------------------------------------------------

/** Round `raw` up to a 1/2/5×10^k "nice" step (`raw <= 0` / non-finite => 1). */
export function niceStep(raw: number): number {
	if (!Number.isFinite(raw) || raw <= 0) return 1;
	const power = Math.floor(Math.log10(raw));
	const base = Math.pow(10, power);
	const norm = raw / base;
	const multiplier = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
	return multiplier * base;
}

/**
 * Ascending axis ticks on a nice 1/2/5×10^k step, covering `[min, max]`.
 *
 * `count` is a target, not a guarantee. Non-finite bounds yield `[]`; a
 * zero-width domain yields a single tick; if no nice multiple falls inside the
 * domain the edges `[min, max]` are returned so an axis always has ticks.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
	let lo = min;
	let hi = max;
	if (hi < lo) [lo, hi] = [hi, lo];
	if (hi === lo) return [lo];
	const target = Number.isFinite(count) && count >= 1 ? Math.trunc(count) : 1;
	const step = niceStep((hi - lo) / target);
	const first = Math.ceil(lo / step) * step;
	const ticks: number[] = [];
	for (let value = first; value <= hi && ticks.length < 1_000; value += step) {
		// Re-snap to the step grid so accumulated float error does not drift.
		ticks.push(Math.round(value / step) * step);
	}
	return ticks.length > 0 ? ticks : [lo, hi];
}

// --- Time buckets -------------------------------------------------------------

/** One dense UTC-day bucket (spec §2.2: `{ day, value }`). */
export interface DayBucket {
	/** UTC calendar day, `YYYY-MM-DD`. */
	day: string;
	value: number;
}

/** Upper bound on emitted buckets, so an unbounded window cannot loop forever. */
export const MAX_DAY_BUCKETS = 3_660;

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/** UTC calendar-day key for an epoch-ms instant (`''` for non-finite input). */
export function utcDayKey(epochMs: number): string {
	if (!Number.isFinite(epochMs)) return '';
	const date = new Date(epochMs);
	return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** UTC calendar-day start for an epoch-ms instant (`NaN` for non-finite input). */
export function utcDayStart(epochMs: number): number {
	return Date.parse(`${utcDayKey(epochMs)}T00:00:00.000Z`);
}

/**
 * Group `{ at, value }` points into dense, ascending UTC-day buckets, summing
 * same-day points and filling missing days with `0`. When `fromMs`/`toMs` are
 * given they bound the emitted range (inclusive); otherwise the range spans the
 * present points. Non-finite `at` is skipped, non-finite `value` counts as `0`.
 */
export function bucketByUtcDay(
	points: readonly { at: number; value: number }[],
	fromMs?: number,
	toMs?: number
): DayBucket[] {
	const totals = new Map<string, number>();
	let minDay = Number.POSITIVE_INFINITY;
	let maxDay = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		if (!Number.isFinite(point.at)) continue;
		const key = utcDayKey(point.at);
		totals.set(key, (totals.get(key) ?? 0) + finite(point.value, 0));
		const dayStart = utcDayStart(point.at);
		minDay = Math.min(minDay, dayStart);
		maxDay = Math.max(maxDay, dayStart);
	}

	const hasFrom = Number.isFinite(fromMs);
	const hasTo = Number.isFinite(toMs);
	let start = hasFrom ? utcDayStart(fromMs as number) : minDay;
	let end = hasTo ? utcDayStart(toMs as number) : maxDay;
	if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
	if (end < start) [start, end] = [end, start];

	const buckets: DayBucket[] = [];
	const dayMs = 86_400_000;
	for (let at = start; at <= end && buckets.length < MAX_DAY_BUCKETS; at += dayMs) {
		const key = utcDayKey(at);
		buckets.push({ day: key, value: totals.get(key) ?? 0 });
	}
	return buckets;
}

// --- Top-N --------------------------------------------------------------------

/**
 * The `n` highest-scoring items, descending, ties broken by input order
 * (stable). `n <= 0` / `NaN` yields `[]`; `Infinity` keeps every item. A
 * non-finite score ranks last; negative scores are kept (callers filter).
 */
export function topN<T>(items: readonly T[], n: number, value: (item: T) => number): T[] {
	if (Number.isNaN(n)) return [];
	const limit = Math.max(0, Math.trunc(n));
	if (limit === 0 || items.length === 0) return [];
	return items
		.map((item, index) => {
			const raw = value(item);
			return { item, index, score: Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY };
		})
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.item);
}
