import { describe, expect, test } from 'bun:test';
import { formatClock, formatDate, formatDateTime, formatDuration, formatIsoDateTime } from './format';

/**
 * Unit tests for the pure display helpers (task #191 / M3b, task #190).
 *
 * `formatClock` feeds the Gantt time axis and cursor, so it must render a
 * deterministic UTC `HH:MM:SS` — SSR and client hydration must agree
 * regardless of the host/browser locale or timezone.
 */

describe('formatClock()', () => {
	test('renders UTC HH:MM:SS', () => {
		expect(formatClock(1_700_000_000_000)).toBe('22:13:20'); // 2023-11-14T22:13:20Z
		expect(formatClock(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('03:04:05');
	});

	test('renders the Unix epoch and midnight as 00:00:00', () => {
		expect(formatClock(0)).toBe('00:00:00');
		expect(formatClock(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('00:00:00');
	});

	test('handles the end-of-day / midnight rollover', () => {
		expect(formatClock(Date.UTC(2026, 0, 1, 23, 59, 59))).toBe('23:59:59');
		expect(formatClock(Date.UTC(2026, 0, 1, 23, 59, 59) + 1_000)).toBe('00:00:00');
	});

	test('always matches a zero-padded HH:MM:SS shape', () => {
		for (const ms of [0, 60_000, 3_600_000, 1_700_000_000_000]) {
			expect(formatClock(ms)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
		}
	});

	test('returns an em dash for non-finite input', () => {
		expect(formatClock(Number.NaN)).toBe('—');
		expect(formatClock(Number.POSITIVE_INFINITY)).toBe('—');
		expect(formatClock(Number.NEGATIVE_INFINITY)).toBe('—');
	});
});

describe('format.ts time helpers (adjacent coverage)', () => {
	test('formatDateTime() renders a deterministic UTC date + time', () => {
		expect(formatDateTime(1_700_000_000_000)).toBe('2023-11-14 22:13:20');
		expect(formatDateTime(Number.NaN)).toBe('—');
	});

	test('formatIsoDateTime() parses an ISO string and dashes absent/invalid input', () => {
		expect(formatIsoDateTime('2023-11-14T22:13:20.000Z')).toBe('2023-11-14 22:13:20');
		expect(formatIsoDateTime(null)).toBe('—');
		expect(formatIsoDateTime(undefined)).toBe('—');
		expect(formatIsoDateTime('')).toBe('—');
		expect(formatIsoDateTime('not-a-date')).toBe('—');
	});

	test('formatDate() renders a deterministic, locale-independent UTC date', () => {
		expect(formatDate(1_700_000_000_000)).toBe('Nov 14, 2023'); // 2023-11-14T22:13:20Z
		expect(formatDate(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('Jan 2, 2026');
		expect(formatDate(Date.UTC(2025, 11, 31, 23, 59, 59))).toBe('Dec 31, 2025');
		expect(formatDate(Number.NaN)).toBe('—');
		expect(formatDate(Number.POSITIVE_INFINITY)).toBe('—');
	});

	test('formatDuration() reports a null end as running and floors seconds', () => {
		expect(formatDuration(0, null)).toBe('running');
		expect(formatDuration(0, 0)).toBe('0s');
		expect(formatDuration(0, 59_000)).toBe('59s');
		expect(formatDuration(0, 60_000)).toBe('1m 0s');
		expect(formatDuration(0, 3_600_000)).toBe('1h 0m');
		// A negative span clamps to zero rather than rendering a negative duration.
		expect(formatDuration(1_000, 0)).toBe('0s');
	});
});
