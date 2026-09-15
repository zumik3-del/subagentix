/**
 * Pure display helpers for the session/turn pages. No I/O and no server
 * imports, so they are safe in the browser bundle and in unit tests.
 *
 * Timestamps format for an explicit IANA `timeZone` (default `'UTC'`), so SSR
 * and hydration agree regardless of the host/browser locale: the server and the
 * first client render both use the default, and the app swaps to the visitor's
 * zone after mount (`initBrowserTimeZone` in `clock.svelte.ts`, called from
 * `+layout.svelte`). The helpers stay runes-free so plain `bun test` can import
 * them.
 */
import { TOKEN_LABELS } from './token';
import type { Usage } from './types';

/**
 * Per-zone `Intl.DateTimeFormat` memo. Pure memoization keyed only by the zone,
 * so it is safe to share across concurrent SSR requests.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

const FIELD_OPTIONS: Intl.DateTimeFormatOptions = {
	hourCycle: 'h23',
	numberingSystem: 'latn',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit'
};

/** Cached formatter for `timeZone`; an invalid zone falls back to UTC. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
	const cached = formatters.get(timeZone);
	if (cached) return cached;
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat('en-US', { ...FIELD_OPTIONS, timeZone });
	} catch {
		// Unknown/empty zone: rendering must never throw — use UTC.
		formatter = new Intl.DateTimeFormat('en-US', { ...FIELD_OPTIONS, timeZone: 'UTC' });
	}
	formatters.set(timeZone, formatter);
	return formatter;
}

interface DateTimeParts {
	year: string;
	month: string;
	day: string;
	hour: string;
	minute: string;
	second: string;
}

/** Zero-padded `Y/M/D H:M:S` field map for `epochMs` in `timeZone`. */
function dateTimeParts(epochMs: number, timeZone: string): DateTimeParts {
	const parts: DateTimeParts = {
		year: '0000',
		month: '00',
		day: '00',
		hour: '00',
		minute: '00',
		second: '00'
	};
	for (const part of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
		if (part.type in parts) parts[part.type as keyof DateTimeParts] = part.value;
	}
	return parts;
}

/** Labelled per-category token counts (order follows the spec's semantics). */
export function tokenBreakdown(usage: Usage): Array<{ label: string; value: number }> {
	return [
		{ label: TOKEN_LABELS.input, value: usage.input },
		{ label: TOKEN_LABELS.output, value: usage.output },
		{ label: TOKEN_LABELS.reasoning, value: usage.reasoning },
		{ label: TOKEN_LABELS.cacheRead, value: usage.cacheRead },
		{ label: TOKEN_LABELS.cacheWrite, value: usage.cacheWrite },
		{ label: TOKEN_LABELS.total, value: usage.total }
	];
}

/** Deterministic `YYYY-MM-DD HH:MM:SS` in `timeZone`; `—` for a non-finite value. */
export function formatDateTime(epochMs: number, timeZone = 'UTC'): string {
	if (!Number.isFinite(epochMs)) return '—';
	const { year, month, day, hour, minute, second } = dateTimeParts(epochMs, timeZone);
	return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/** `YYYY-MM-DD HH:MM:SS` for an ISO-8601 string in `timeZone`; `—` when absent/invalid. */
export function formatIsoDateTime(value: string | null | undefined, timeZone = 'UTC'): string {
	if (!value) return '—';
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? formatDateTime(ms, timeZone) : '—';
}

/** Deterministic `HH:MM:SS` in `timeZone` for axis ticks and the time cursor. */
export function formatClock(epochMs: number, timeZone = 'UTC'): string {
	if (!Number.isFinite(epochMs)) return '—';
	const { hour, minute, second } = dateTimeParts(epochMs, timeZone);
	return `${hour}:${minute}:${second}`;
}

const MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
] as const;

/** Human-friendly, locale-independent `Mon D, YYYY` in `timeZone`; `—` when invalid. */
export function formatDate(epochMs: number, timeZone = 'UTC'): string {
	if (!Number.isFinite(epochMs)) return '—';
	const { year, month, day } = dateTimeParts(epochMs, timeZone);
	return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/** Human wall-clock duration; a `null` end means the span is still running. */
export function formatDuration(startedAt: number, endedAt: number | null): string {
	if (endedAt === null) return 'running';
	const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

/** Group-separated integer (fixed locale for deterministic output). */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return '—';
	return new Intl.NumberFormat('en-US').format(value);
}

/** Gross cost as USD with enough precision for small amounts. */
export function formatCost(value: number): string {
	if (!Number.isFinite(value)) return '—';
	return `$${value.toFixed(4)}`;
}
