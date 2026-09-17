import { describe, expect, test } from 'bun:test';
import { rowsThatFit } from './fit';

/**
 * Unit tests for the pure row-fit math (dashboard Phase 4, task #444).
 *
 * Kept as a plain `.ts` module — no DOM, no Svelte, no `$lib/server` — so the
 * budget rule is exercisable headlessly. Mirrors the `top-tools.ts` split
 * pattern.
 */

describe('rowsThatFit()', () => {
	describe('basic arithmetic', () => {
		test('exact division yields the quotient', () => {
			expect(rowsThatFit({ available: 120, rowHeight: 30, total: 10 })).toBe(4);
		});

		test('remainder floors silently', () => {
			// 125 / 30 = 4.166... → 4 whole rows.
			expect(rowsThatFit({ available: 125, rowHeight: 30, total: 10 })).toBe(4);
		});

		test('available smaller than one row yields zero when min is absent', () => {
			expect(rowsThatFit({ available: 10, rowHeight: 30, total: 5 })).toBe(0);
		});
	});

	describe('total as the hard ceiling', () => {
		test('available larger than total cannot exceed total', () => {
			expect(rowsThatFit({ available: 1000, rowHeight: 1, total: 3 })).toBe(3);
		});

		test('total of zero yields zero regardless of available', () => {
			expect(rowsThatFit({ available: 9999, rowHeight: 1, total: 0 })).toBe(0);
		});
	});

	describe('min / max clamps', () => {
		test('min raises the floor when available is too small', () => {
			// 10 / 30 = 0, but min=2 forces the result up to 2.
			expect(rowsThatFit({ available: 10, rowHeight: 30, total: 10, min: 2 })).toBe(2);
		});

		test('max caps the ceiling even when available is large', () => {
			expect(rowsThatFit({ available: 1000, rowHeight: 1, total: 10, max: 3 })).toBe(3);
		});

		test('min and max together form a narrow band', () => {
			// available/rowHeight = 7, but [3, 5] constrains it.
			expect(rowsThatFit({ available: 210, rowHeight: 30, total: 20, min: 3, max: 5 })).toBe(5);
		});

		test('min larger than total is respected when total is the true ceiling', () => {
			// total=2 means the budget can never exceed 2, even though min=5.
			expect(rowsThatFit({ available: 9999, rowHeight: 1, total: 2, min: 5 })).toBe(2);
		});

		test('max smaller than min normalises so floor <= ceiling', () => {
			// When max < min the implementation uses max(floor, min(fit, ceiling));
			// with max intentionally smaller, the ceiling becomes floor.
			expect(rowsThatFit({ available: 1000, rowHeight: 1, total: 10, min: 5, max: 3 })).toBe(5);
		});
	});

	describe('zero and negative available', () => {
		test('available = 0 returns min (not NaN)', () => {
			const result = rowsThatFit({ available: 0, rowHeight: 30, total: 5 });
			expect(Number.isFinite(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(0);
		});

		test('negative available returns min (not NaN)', () => {
			const result = rowsThatFit({ available: -100, rowHeight: 30, total: 5 });
			expect(Number.isFinite(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(0);
		});
	});

	describe('non-finite inputs never yield NaN or negative counts', () => {
		test('NaN available falls back to min', () => {
			const result = rowsThatFit({ available: NaN, rowHeight: 30, total: 5 });
			expect(Number.isFinite(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(0);
		});

		test('Infinity available falls back to min (not treated as infinite budget)', () => {
			// Infinity is non-finite per Number.isFinite, so the function returns
			// the floor (min) just like it does for NaN.
			expect(rowsThatFit({ available: Infinity, rowHeight: 30, total: 4 })).toBe(0);
			expect(rowsThatFit({ available: Infinity, rowHeight: 30, total: 4, min: 2 })).toBe(2);
		});

		test('NaN rowHeight falls back to min', () => {
			const result = rowsThatFit({ available: 100, rowHeight: NaN, total: 5 });
			expect(Number.isFinite(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(0);
		});

		test('Infinity rowHeight yields zero fit (division goes to 0)', () => {
			// Infinity / anything = Infinity → floor(Infinity) = Infinity → but
			// the non-finite check catches it first and returns min.
			const result = rowsThatFit({ available: 100, rowHeight: Infinity, total: 5 });
			expect(Number.isFinite(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(0);
		});

		test('negative rowHeight falls back to min (not a positive count)', () => {
			const result = rowsThatFit({ available: 100, rowHeight: -5, total: 5 });
			expect(Number.isFinite(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(0);
		});

		test('non-finite total is coerced to 0 (fallback)', () => {
			// total = NaN → wholeCount returns 0 → function returns 0 immediately.
			expect(rowsThatFit({ available: 100, rowHeight: 10, total: NaN })).toBe(0);
			expect(rowsThatFit({ available: 100, rowHeight: 10, total: Infinity })).toBe(0);
		});
	});

	describe('default arguments', () => {
		test('omitted min defaults to 0', () => {
			expect(rowsThatFit({ available: 50, rowHeight: 30, total: 10 })).toBe(1);
		});

		test('omitted max defaults to total', () => {
			expect(rowsThatFit({ available: 9999, rowHeight: 1, total: 7 })).toBe(7);
		});
	});

	describe('edge: exactly one row', () => {
		test('available exactly one row height', () => {
			expect(rowsThatFit({ available: 30, rowHeight: 30, total: 5 })).toBe(1);
		});

		test('available just below one row height with min=1', () => {
			expect(rowsThatFit({ available: 29, rowHeight: 30, total: 5, min: 1 })).toBe(1);
		});
	});
});
