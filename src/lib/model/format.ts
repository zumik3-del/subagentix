/**
 * Pure display helpers for the session/turn pages. No I/O and no server
 * imports, so they are safe in the browser bundle and in unit tests.
 *
 * Dates are rendered in UTC (`YYYY-MM-DD HH:MM:SS`) so SSR and hydration agree
 * regardless of the host/browser locale.
 */
import { TOKEN_LABELS } from './token';
import type { Usage } from './types';

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

/** Deterministic UTC timestamp; `—` for a non-finite value. */
export function formatDateTime(epochMs: number): string {
	if (!Number.isFinite(epochMs)) return '—';
	return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}

/** Deterministic UTC timestamp for an ISO-8601 string; `—` when absent/invalid. */
export function formatIsoDateTime(value: string | null | undefined): string {
	if (!value) return '—';
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? formatDateTime(ms) : '—';
}

/** Deterministic UTC time-of-day `HH:MM:SS` for axis ticks and the time cursor. */
export function formatClock(epochMs: number): string {
	if (!Number.isFinite(epochMs)) return '—';
	return new Date(epochMs).toISOString().slice(11, 19);
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

/** Human-friendly, locale-independent UTC date `Mon D, YYYY`; `—` when invalid. */
export function formatDate(epochMs: number): string {
	if (!Number.isFinite(epochMs)) return '—';
	const d = new Date(epochMs);
	return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
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
