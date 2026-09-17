/**
 * Pure whole-row fitting math for the dashboard widget bodies (task #444).
 *
 * Kept out of the Svelte bodies so the budget rule is testable without a
 * renderer or a DOM, mirroring the `top-tools.ts` / `picker.ts` helper split.
 * No DOM, no Svelte and no `$lib/server` import:
 * the live measurement lives in `fit.svelte.ts`.
 */

/** Inputs to {@link rowsThatFit}: the measured box and the row bounds. */
export interface RowFitInput {
	/** Usable box height in pixels (e.g. the clipped list container). */
	available: number;
	/** Height in pixels of one rendered row. */
	rowHeight: number;
	/** Rows the payload offers; the budget never exceeds this. */
	total: number;
	/** Floor on the returned budget (default `0`). */
	min?: number;
	/** Ceiling on the returned budget (default: `total`). */
	max?: number;
}

/** Finite, non-negative whole number, or `fallback` for non-finite input. */
function wholeCount(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/**
 * How many whole rows fit in `available`, clamped to `[min, max]` and to
 * `total`. Truncation is silent and whole-row: the caller renders
 * `rows.slice(0, rowsThatFit(...))`.
 *
 * A zero/negative/non-finite `available` or `rowHeight` (a box not laid out
 * yet, a missing first row) cannot be divided, so the floor `min` is returned —
 * never `NaN`, `Infinity` or a fractional row.
 */
export function rowsThatFit(input: RowFitInput): number {
	const { available, rowHeight, total, min = 0, max } = input;
	const rows = wholeCount(total, 0);
	if (rows <= 0) return 0;
	const floor = Math.min(rows, wholeCount(min, 0));
	const ceiling = Math.max(floor, Math.min(rows, wholeCount(max ?? rows, rows)));
	if (!Number.isFinite(available) || !Number.isFinite(rowHeight) || rowHeight <= 0) {
		return floor;
	}
	const fit = Math.floor(available / rowHeight);
	return Math.max(0, Math.max(floor, Math.min(fit, ceiling)));
}
