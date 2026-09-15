import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
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

/**
 * Task #371 / #372: tz-aware formatting and the source guard that keeps every
 * call site in .svelte files anchored to clock.tz (SSR stays UTC; client swaps
 * post-hydration via initBrowserTimeZone in +layout.svelte).
 */
describe('tz-aware formatting (task #371/#372)', () => {
	const MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

	test('formatDateTime Asia/Kolkata rolls date forward (UTC+5:30)', () => {
		expect(formatDateTime(MS, 'Asia/Kolkata')).toBe('2023-11-15 03:43:20');
	});

	test('formatClock America/New_York is UTC-5 in EST (post-DST Nov 14 2023)', () => {
		expect(formatClock(MS, 'America/New_York')).toBe('17:13:20');
	});

	test('formatDate Asia/Kolkata rolls the date into the next day', () => {
		expect(formatDate(MS, 'Asia/Kolkata')).toBe('Nov 15, 2023');
	});

	test('formatDate rolls over year boundary in a forward-shifted zone', () => {
		// 2025-12-31 23:59:59 UTC -> 2026-01-01 05:29:59 Asia/Kolkata
		expect(formatDate(Date.UTC(2025, 11, 31, 23, 59, 59), 'Asia/Kolkata')).toBe('Jan 1, 2026');
	});

	test('formatIsoDateTime respects the tz arg', () => {
		expect(formatIsoDateTime('2023-11-14T22:13:20.000Z', 'Asia/Kolkata')).toBe('2023-11-15 03:43:20');
	});

	test('invalid / unknown tz falls back to UTC without throwing', () => {
		// Malformed IANA string: formatterFor catches the exception and uses UTC.
		expect(() => formatDateTime(MS, 'Not/AZone')).not.toThrow();
		expect(formatDateTime(MS, 'Not/AZone')).toBe('2023-11-14 22:13:20');
		expect(() => formatClock(MS, '')).not.toThrow();
		expect(formatClock(MS, '')).toBe('22:13:20');
		expect(() => formatDate(MS, '???')).not.toThrow();
		expect(formatDate(MS, '???')).toBe('Nov 14, 2023');
		expect(() => formatIsoDateTime('2023-11-14T22:13:20.000Z', 'xyz')).not.toThrow();
		expect(formatIsoDateTime('2023-11-14T22:13:20.000Z', 'xyz')).toBe('2023-11-14 22:13:20');
	});

	test('default (no tz arg) preserves the old UTC behavior', () => {
		expect(formatDateTime(MS)).toBe('2023-11-14 22:13:20');
		expect(formatClock(MS)).toBe('22:13:20');
		expect(formatDate(MS)).toBe('Nov 14, 2023');
		expect(formatIsoDateTime('2023-11-14T22:13:20.000Z')).toBe('2023-11-14 22:13:20');
	});
});

describe('source guard — clock.tz at every call site (task #371/#372)', () => {
	test('clock.svelte.ts defaults to UTC and exports initBrowserTimeZone', () => {
		const source = readFileSync(new URL('./clock.svelte.ts', import.meta.url), 'utf8');
		expect(source).toContain("tz: 'UTC'");
		expect(source).toContain('export function initBrowserTimeZone');
	});

	test('+layout.svelte calls initBrowserTimeZone on mount', () => {
		const source = readFileSync(
			new URL('../../routes/+layout.svelte', import.meta.url),
			'utf8'
		);
		expect(source).toContain("import { initBrowserTimeZone } from '$lib/model/clock.svelte'");
		expect(source).toContain('onMount(() => initBrowserTimeZone())');
	});

	test('every format-clock call in .svelte sources passes clock.tz as the second arg', () => {
		// We scan the component source trees for calls to the four public format
		// helpers. Any call without an explicit second argument would silently
		// fall back to UTC and defeat the whole point of the browser-timezone
		// swap, so we assert that every usage is anchored to clock.tz.
		const svelteDirs = [
			new URL('../../lib/components/features/gantt/', import.meta.url),
			new URL('../../lib/components/features/node-detail/', import.meta.url),
			new URL('../../lib/components/features/sidebar/', import.meta.url),
			new URL('../../lib/components/features/tracker/', import.meta.url),
			new URL('../../routes/sessions/[id]/', import.meta.url)
		];
		const orphanCalls: string[] = [];
		for (const dir of svelteDirs) {
			const files = readdirSync(dir, { recursive: true });
			for (const file of files) {
				if (typeof file !== 'string' || !file.endsWith('.svelte')) continue;
				const text = readFileSync(new URL(file, dir), 'utf8');
				// Match formatClock/formatDateTime/formatDate/formatIsoDateTime calls
				// that do NOT have a second argument containing clock.tz.
				// We look for patterns like formatXxx(arg) with no comma after arg,
				// excluding the helper definitions themselves.
				for (const fn of ['formatClock', 'formatDateTime', 'formatDate', 'formatIsoDateTime']) {
					const re = new RegExp(`${fn}\\([^)]*\\)`, 'g');
					let m: RegExpExecArray | null;
					while ((m = re.exec(text)) !== null) {
						const call = m[0];
						// Skip if the call already has a second arg with clock.tz
						if (/clock\.tz/.test(call)) continue;
						// Skip the function definitions in format.ts (not in these dirs)
						orphanCalls.push(`${file}:${call}`);
					}
				}
			}
		}
		expect(orphanCalls, `orphan format calls missing clock.tz: ${orphanCalls.join(', ')}`).toEqual([]);
	});
});
