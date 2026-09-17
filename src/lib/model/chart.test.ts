import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	bucketByUtcDay,
	linearScale,
	MAX_DAY_BUCKETS,
	niceStep,
	niceTicks,
	topN,
	utcDayKey
} from './chart';

/**
 * Unit tests for the pure chart math (dashboard Phase 1, task #402).
 *
 * `chart.ts` runs in SSR, the client bundle and `bun test`, so it must stay
 * DOM-free and free of any `uplot` import. These tests pin the scale/tick/
 * bucket/top-N contracts, including the degenerate cases (empty, single
 * item, all-equal) called out in the spec.
 */

const DAY = 86_400_000;

describe('linearScale()', () => {
	test('maps domain endpoints onto range endpoints and interpolates linearly', () => {
		const scale = linearScale([0, 100], [0, 200]);
		expect(scale(0)).toBe(0);
		expect(scale(50)).toBe(100);
		expect(scale(100)).toBe(200);
	});

	test('exposes the sanitised domain and range', () => {
		const scale = linearScale([0, 100], [10, 30]);
		expect(scale.domain).toEqual([0, 100]);
		expect(scale.range).toEqual([10, 30]);
	});

	test('supports a descending range (inverted y-axis)', () => {
		const scale = linearScale([0, 100], [200, 0]);
		expect(scale(0)).toBe(200);
		expect(scale(100)).toBe(0);
	});

	test('does not clamp out-of-domain values (callers clamp if needed)', () => {
		const scale = linearScale([0, 100], [0, 200]);
		expect(scale(-10)).toBe(-20);
		expect(scale(150)).toBe(300);
	});

	test('a zero-width domain degrades to a constant at range[0]', () => {
		const scale = linearScale([5, 5], [0, 200]);
		expect(scale(0)).toBe(0);
		expect(scale(5)).toBe(0);
		expect(scale(5_000)).toBe(0);
	});

	test('a non-finite value maps to range[0] without NaN', () => {
		const scale = linearScale([0, 100], [3, 7]);
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(scale(value)).toBe(3);
		}
	});

	test('a non-finite domain bound falls back to a finite one', () => {
		const scale = linearScale([Number.NaN, Number.POSITIVE_INFINITY], [0, 10]);
		expect(Number.isFinite(scale.domain[0])).toBe(true);
		expect(Number.isFinite(scale.domain[1])).toBe(true);
		expect(Number.isFinite(scale(5))).toBe(true);
	});

	test('is deterministic for identical input', () => {
		expect(linearScale([1, 9], [0, 100])(4)).toBe(linearScale([1, 9], [0, 100])(4));
	});
});

describe('niceStep()', () => {
	test('rounds up to the nearest 1/2/5×10^k', () => {
		expect(niceStep(1)).toBe(1);
		expect(niceStep(1.5)).toBe(2);
		expect(niceStep(3)).toBe(5);
		expect(niceStep(7)).toBe(10);
		expect(niceStep(12)).toBe(20);
		expect(niceStep(230)).toBe(500);
		expect(niceStep(0.03)).toBe(0.05);
	});

	test('degenerate input (0 / negative / NaN) yields step 1', () => {
		for (const raw of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(niceStep(raw)).toBe(1);
		}
	});
});

describe('niceTicks()', () => {
	test('produces an ascending, de-duplicated set inside the domain', () => {
		const ticks = niceTicks(0, 100, 5);
		expect(ticks).toEqual([0, 20, 40, 60, 80, 100]);
		expect(new Set(ticks).size).toBe(ticks.length);
		expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
		expect(ticks[0]).toBeGreaterThanOrEqual(0);
		expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(100);
	});

	test('handles a negative domain', () => {
		expect(niceTicks(-50, 50, 5)).toEqual([-40, -20, 0, 20, 40]);
	});

	test('a single value (zero-width domain) yields one tick', () => {
		expect(niceTicks(3, 3, 5)).toEqual([3]);
		expect(niceTicks(0, 0)).toEqual([0]);
	});

	test('a non-finite bound yields no ticks', () => {
		expect(niceTicks(Number.NaN, 10)).toEqual([]);
		expect(niceTicks(0, Number.POSITIVE_INFINITY)).toEqual([]);
	});

	test('normalises a reversed domain', () => {
		expect(niceTicks(100, 0, 5)).toEqual(niceTicks(0, 100, 5));
	});

	test('honours the target count as a hint without exploding', () => {
		const coarse = niceTicks(0, 60, 2);
		const fine = niceTicks(0, 60, 20);
		expect(coarse.length).toBeLessThanOrEqual(fine.length);
		// count < 1 is clamped, not a division by zero / empty axis.
		expect(niceTicks(0, 10, 0).length).toBeGreaterThan(0);
	});

	test('always returns at least one tick for a finite domain', () => {
		for (const [min, max] of [[0, 1], [3, 3.4], [-1, 0], [1_000, 1_001]] as const) {
			expect(niceTicks(min, max, 1).length, `${min}..${max}`).toBeGreaterThan(0);
		}
	});
});

describe('utcDayKey()', () => {
	test('renders a zero-padded UTC YYYY-MM-DD', () => {
		expect(utcDayKey(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02');
		expect(utcDayKey(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
		expect(utcDayKey(0)).toBe('1970-01-01');
	});

	test('always matches the YYYY-MM-DD shape', () => {
		for (const ms of [0, DAY, Date.UTC(2026, 6, 4)]) {
			expect(utcDayKey(ms)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	test('returns an empty string for non-finite input', () => {
		expect(utcDayKey(Number.NaN)).toBe('');
		expect(utcDayKey(Number.POSITIVE_INFINITY)).toBe('');
	});
});

describe('bucketByUtcDay()', () => {
	test('sums same-day points into dense ascending buckets with zero-filled gaps', () => {
		const buckets = bucketByUtcDay(
			[
				{ at: Date.UTC(2026, 0, 1, 5), value: 2 },
				{ at: Date.UTC(2026, 0, 1, 23), value: 3 },
				{ at: Date.UTC(2026, 0, 3, 12), value: 1 }
			],
			Date.UTC(2026, 0, 1),
			Date.UTC(2026, 0, 3)
		);
		expect(buckets).toEqual([
			{ day: '2026-01-01', value: 5 },
			{ day: '2026-01-02', value: 0 },
			{ day: '2026-01-03', value: 1 }
		]);
	});

	test('without explicit bounds, fills the gaps between the present days', () => {
		const buckets = bucketByUtcDay([
			{ at: Date.UTC(2026, 0, 1), value: 1 },
			{ at: Date.UTC(2026, 0, 4), value: 1 }
		]);
		expect(buckets.map((bucket) => bucket.day)).toEqual([
			'2026-01-01',
			'2026-01-02',
			'2026-01-03',
			'2026-01-04'
		]);
		expect(buckets.map((bucket) => bucket.value)).toEqual([1, 0, 0, 1]);
	});

	test('explicit bounds clip the range and pad both edges with zeros', () => {
		const buckets = bucketByUtcDay(
			[{ at: Date.UTC(2026, 0, 2), value: 4 }],
			Date.UTC(2025, 11, 31),
			Date.UTC(2026, 0, 3)
		);
		expect(buckets).toEqual([
			{ day: '2025-12-31', value: 0 },
			{ day: '2026-01-01', value: 0 },
			{ day: '2026-01-02', value: 4 },
			{ day: '2026-01-03', value: 0 }
		]);
	});

	test('skips non-finite timestamps and treats a non-finite value as 0', () => {
		const buckets = bucketByUtcDay([
			{ at: Number.NaN, value: 9 },
			{ at: Date.UTC(2026, 0, 1), value: Number.NaN }
		]);
		expect(buckets).toEqual([{ day: '2026-01-01', value: 0 }]);
	});

	test('empty input with no bounds yields no buckets', () => {
		expect(bucketByUtcDay([])).toEqual([]);
	});

	test('empty input with explicit bounds still yields the dense zero window', () => {
		const buckets = bucketByUtcDay([], Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2));
		expect(buckets).toEqual([
			{ day: '2026-01-01', value: 0 },
			{ day: '2026-01-02', value: 0 }
		]);
	});

	test('normalises a reversed window', () => {
		const buckets = bucketByUtcDay([], Date.UTC(2026, 0, 3), Date.UTC(2026, 0, 1));
		expect(buckets.map((bucket) => bucket.day)).toEqual([
			'2026-01-01',
			'2026-01-02',
			'2026-01-03'
		]);
	});

	test('caps the bucket count on an unbounded window', () => {
		const buckets = bucketByUtcDay([], Date.UTC(1900, 0, 1), Date.UTC(2100, 0, 1));
		expect(buckets.length).toBe(MAX_DAY_BUCKETS);
	});
});

describe('topN()', () => {
	const value = (n: number) => n;

	test('returns the highest values in descending order', () => {
		expect(topN([3, 1, 2], 2, value)).toEqual([3, 2]);
	});

	test('caps at n and returns everything when n exceeds the input', () => {
		expect(topN([1, 2, 3], 10, value)).toEqual([3, 2, 1]);
		expect(topN([1, 2, 3], 3, value)).toEqual([3, 2, 1]);
	});

	test('ties keep input order (stable)', () => {
		const items = [{ n: 1, tag: 'a' }, { n: 1, tag: 'b' }, { n: 1, tag: 'c' }];
		expect(topN(items, 2, (item) => item.n).map((item) => item.tag)).toEqual(['a', 'b']);
	});

	test('all-equal values keep the first n in input order', () => {
		expect(topN(['a', 'b', 'c'], 2, () => 5)).toEqual(['a', 'b']);
	});

	test('n <= 0 or NaN yields an empty list', () => {
		expect(topN([1, 2, 3], 0, value)).toEqual([]);
		expect(topN([1, 2, 3], -1, value)).toEqual([]);
		expect(topN([1, 2, 3], Number.NaN, value)).toEqual([]);
	});

	test('Infinity keeps every item', () => {
		expect(topN([1, 2, 3], Number.POSITIVE_INFINITY, value)).toEqual([3, 2, 1]);
	});

	test('an empty input yields an empty list', () => {
		expect(topN([], 5, value)).toEqual([]);
	});

	test('a non-finite score ranks last and negative scores are kept', () => {
		const items = ['bad', 'neg', 'good'];
		const score = (item: string) => (item === 'bad' ? Number.NaN : item === 'neg' ? -1 : 2);
		expect(topN(items, 3, score)).toEqual(['good', 'neg', 'bad']);
	});

	test('does not mutate the input array', () => {
		const input = [1, 3, 2];
		topN(input, 2, value);
		expect(input).toEqual([1, 3, 2]);
	});
});

describe('chart.ts stays DOM-free and uPlot-free (spec §2.6)', () => {
	const source = readFileSync(new URL('./chart.ts', import.meta.url), 'utf8');

	test('does not import uplot, Svelte, $lib/server or the DOM', () => {
		expect(source).not.toMatch(/from ['"]uplot['"]/);
		expect(source).not.toMatch(/import\(['"]uplot['"]\)/);
		expect(source).not.toMatch(/from ['"]\$lib\/server/);
		expect(source).not.toMatch(/from ['"]bun:sqlite/);
		expect(source).not.toMatch(/from ['"]svelte/);
		expect(source).not.toMatch(/\bdocument\.|\bwindow\./);
	});
});
