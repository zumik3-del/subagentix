/**
 * Display helpers for the `/files` feature (epic #775, spec T3).
 *
 * `formatBytes` renders the metadata `size` returned by the discovery layer as
 * a compact, human-readable string; it is pure so the row markup stays a
 * straight interpolation.
 */

const UNITS = ['B', 'kB', 'MB', 'GB'] as const;

/** Compact byte size (binary multiples), e.g. `0 B`, `512 B`, `1.5 kB`. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
	return `${rounded} ${UNITS[unit]}`;
}
