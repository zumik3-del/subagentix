import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	DASHBOARD_PERIODS,
	isDashboardPeriod,
	periodDays,
	resolveTimeWindow,
	type DashboardPeriod
} from './dashboard';
import type { TimeWindow } from './dashboard';

/**
 * Unit tests for the pure dashboard domain (dashboard Phase 1, task #403).
 *
 * `dashboard.ts` runs in SSR, the client bundle and `bun test`, so it must stay
 * DOM-free and free of `$lib/server`. These tests pin the period selector, the
 * rolling-day contract, the 'today' calendar-day preset and the non-finite
 * `now` degradation — all with fixed epoch constants rather than the wall clock.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed epoch-ms constant so tests are timezone- and moment-independent. */
const FIXED_NOW = Date.UTC(2026, 8, 15, 14, 30, 0); // 2026-09-15T14:30:00.000Z
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// DASHBOARD_PERIODS
// ---------------------------------------------------------------------------

describe('DASHBOARD_PERIODS', () => {
	test('contains every preset exactly once, in enum order', () => {
		expect(DASHBOARD_PERIODS).toEqual(['all', 'today', '3d', '7d', '30d', '90d']);
		expect(new Set(DASHBOARD_PERIODS).size).toBe(DASHBOARD_PERIODS.length);
	});
});

// ---------------------------------------------------------------------------
// periodDays
// ---------------------------------------------------------------------------

describe('periodDays()', () => {
	test('returns 3 for "3d"', () => {
		expect(periodDays('3d')).toBe(3);
	});

	test('returns 7 for "7d"', () => {
		expect(periodDays('7d')).toBe(7);
	});

	test('returns 30 for "30d"', () => {
		expect(periodDays('30d')).toBe(30);
	});

	test('returns 90 for "90d"', () => {
		expect(periodDays('90d')).toBe(90);
	});

	test('returns null for "all" (unbounded)', () => {
		expect(periodDays('all')).toBeNull();
	});

	test('returns null for "today" (calendar day, not a rolling count)', () => {
		expect(periodDays('today')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// isDashboardPeriod
// ---------------------------------------------------------------------------

describe('isDashboardPeriod()', () => {
	test('accepts every valid preset including the new ones', () => {
		for (const p of DASHBOARD_PERIODS) {
			expect(isDashboardPeriod(p)).toBe(true);
		}
	});

	test('rejects an unknown string', () => {
		expect(isDashboardPeriod('invalid')).toBe(false);
		expect(isDashboardPeriod('')).toBe(false);
		expect(isDashboardPeriod('1d')).toBe(false);
		expect(isDashboardPeriod('2d')).toBe(false);
		expect(isDashboardPeriod('100d')).toBe(false);
	});

	test('rejects non-string input', () => {
		expect(isDashboardPeriod(null)).toBe(false);
		expect(isDashboardPeriod(undefined)).toBe(false);
		expect(isDashboardPeriod(42)).toBe(false);
		expect(isDashboardPeriod({})).toBe(false);
		expect(isDashboardPeriod(true)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// resolveTimeWindow
// ---------------------------------------------------------------------------

describe('resolveTimeWindow()', () => {
	test('"all" is unbounded in both directions', () => {
		const win = resolveTimeWindow('all', FIXED_NOW);
		expect(win).toEqual({ from: null, to: null });
	});

	test('"7d" | "30d" | "90d" span the expected day count ending at now', () => {
		const cases: [DashboardPeriod, number][] = [
			['7d', 7],
			['30d', 30],
			['90d', 90]
		];
		for (const [period, days] of cases) {
			const win = resolveTimeWindow(period, FIXED_NOW);
			expect(win.from).toBe(FIXED_NOW - days * DAY_MS);
			expect(win.to).toBe(FIXED_NOW);
		}
	});

	test('"3d" spans exactly 3 days ending at now', () => {
		const win = resolveTimeWindow('3d', FIXED_NOW);
		expect(win.from).toBe(FIXED_NOW - 3 * DAY_MS);
		expect(win.to).toBe(FIXED_NOW);
	});

	test('"today" starts at the current UTC midnight and ends at now', () => {
		const win = resolveTimeWindow('today', FIXED_NOW);
		// FIXED_NOW = 2026-09-15T14:30:00.000Z so utcDayStart = 2026-09-15T00:00:00.000Z
		expect(win.from).toBe(Date.UTC(2026, 8, 15));
		expect(win.to).toBe(FIXED_NOW);
		expect(win.from as number).toBeLessThan(win.to as number);
	});

	test('"today" at exactly 00:00:00.000Z gives from === to (never negative)', () => {
		const instant = Date.UTC(2026, 8, 15);
		const win = resolveTimeWindow('today', instant);
		expect(win.from).toBe(instant);
		expect(win.to).toBe(instant);
		expect(win.from).toBe(win.to);
	});

	test('a non-finite now degrades to unbounded for every preset including the new ones', () => {
		const unbounded: TimeWindow = { from: null, to: null };
		for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			for (const period of DASHBOARD_PERIODS) {
				expect(resolveTimeWindow(period, now), `${period} at ${now}`).toEqual(unbounded);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// DOM / server-free contract
// ---------------------------------------------------------------------------

describe('dashboard.ts stays DOM-free and server-free (spec §2.1)', () => {
	const source = readFileSync(new URL('./dashboard.ts', import.meta.url), 'utf8');

	test('does not import $lib/server, Svelte or bun:sqlite', () => {
		expect(source).not.toMatch(/from ['"]\$lib\/server/);
		expect(source).not.toMatch(/from ['"]bun:sqlite/);
		expect(source).not.toMatch(/from ['"]svelte/);
	});
});
