/**
 * Pure chart math for the dashboard widgets (dashboard Phase 1, task #402).
 *
 * No DOM, no Svelte and no chart-library import: this module is safe in SSR, in
 * the client bundle and in `bun test`, mirroring `model/gantt.ts`. Every
 * function is deterministic and side-effect free, so the scales, ticks, buckets,
 * arcs and top-N truncation are testable without a renderer.
 */

/** Full turn, in radians. */
export const TAU = Math.PI * 2;

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

// --- Arc / pie ----------------------------------------------------------------

/** One donut/pie slice: its share and its angular span. */
export interface ArcSegment {
	/** Input index, so callers can match a slice back to its label. */
	index: number;
	/** Non-negative value used for the share (input clamped to `>= 0`). */
	value: number;
	/** Share of the total `[0, 1]`; `0` for every slice when the total is `0`. */
	fraction: number;
	startAngle: number;
	endAngle: number;
}

/**
 * Split values into cumulative angular segments over `[startAngle, endAngle]`.
 * Angles are in radians, `0` at 12 o'clock, increasing clockwise (SVG y-down).
 * Negative/non-finite values count as `0`; an all-zero input yields zero-width
 * segments so nothing is rendered for a meaningless slice.
 */
export function arcSegments(
	values: readonly number[],
	startAngle = 0,
	endAngle = TAU
): ArcSegment[] {
	const safe = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
	const total = safe.reduce((sum, value) => sum + value, 0);
	const span = finite(endAngle - startAngle, 0);
	let cursor = finite(startAngle, 0);
	return safe.map((value, index) => {
		const fraction = total > 0 ? value / total : 0;
		const from = cursor;
		const to = total > 0 ? cursor + fraction * span : cursor;
		cursor = to;
		return { index, value, fraction, startAngle: from, endAngle: to };
	});
}

function svgPoint(cx: number, cy: number, radius: number, angle: number): string {
	return `${cx + radius * Math.sin(angle)} ${cy - radius * Math.cos(angle)}`;
}

function arcSegment(
	cx: number,
	cy: number,
	rOuter: number,
	rInner: number,
	from: number,
	to: number,
	largeArc: number
): string {
	const outerStart = svgPoint(cx, cy, rOuter, from);
	const outerEnd = svgPoint(cx, cy, rOuter, to);
	if (rInner <= 0) {
		return `M ${cx} ${cy} L ${outerStart} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${outerEnd} Z`;
	}
	const innerEnd = svgPoint(cx, cy, rInner, to);
	const innerStart = svgPoint(cx, cy, rInner, from);
	return (
		`M ${outerStart} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${outerEnd}` +
		` L ${innerEnd} A ${rInner} ${rInner} 0 ${largeArc} 0 ${innerStart} Z`
	);
}

/**
 * SVG `d` for one donut slice (`rInner > 0`) or pie wedge (`rInner <= 0`).
 * `startAngle`/`endAngle` are radians, `0` at 12 o'clock, increasing clockwise.
 * A negative sweep is normalised; a zero sweep or invalid radius yields `''`;
 * a full turn is split into two arcs because SVG cannot express 2π in one.
 */
export function arcPath(
	cx: number,
	cy: number,
	rOuter: number,
	rInner: number,
	startAngle: number,
	endAngle: number
): string {
	if (!Number.isFinite(rOuter) || rOuter <= 0) return '';
	const outer = rOuter;
	const inner = Math.max(0, Math.min(finite(rInner, 0), outer));
	let from = finite(startAngle, 0);
	let to = finite(endAngle, 0);
	let sweep = to - from;
	if (sweep === 0) return '';
	if (sweep < 0) {
		const swap = from;
		from = to;
		to = swap;
		sweep = -sweep;
	}
	if (sweep >= TAU) {
		const mid = from + Math.PI;
		return `${arcSegment(cx, cy, outer, inner, from, mid, 1)} ${arcSegment(
			cx,
			cy,
			outer,
			inner,
			mid,
			from + TAU,
			1
		)}`;
	}
	const largeArc = sweep > Math.PI ? 1 : 0;
	return arcSegment(cx, cy, outer, inner, from, to, largeArc);
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
