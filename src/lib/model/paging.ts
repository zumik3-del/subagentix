/**
 * Pure turn-list windowing (M4b, ADR §4.4).
 *
 * Huge sessions (up to 174 turns) must not all render. This helper slices a
 * bounded window out of the full turn list while guaranteeing that the
 * currently selected `?turn=` is always inside it when it fits: if the
 * selection falls outside the requested window, the window is grown (still
 * bounded at `2 × size`) to also include it. No DB / `$lib/server` imports —
 * importable from client code and unit-testable in isolation.
 *
 * The pager links are derived from the *rendered* bounds (see
 * `turnPageTargets`) so that following them always advances instead of
 * re-requesting the window the selection forced into view.
 */
import type { TurnSummary, TurnWindow } from './types';

/** Default rendered window size for the turn list (ADR §4.4). */
export const DEFAULT_TURN_WINDOW = 50;

function toSize(size: number): number {
	if (!Number.isFinite(size)) return DEFAULT_TURN_WINDOW;
	return Math.max(1, Math.trunc(size));
}

/** Tuning for {@link windowTurns}. */
export interface TurnWindowOptions {
	/**
	 * When `true`, an explicit `requestedStart` is authoritative: the requested
	 * page is kept and grown (at most `2 × size` turns) to also include the
	 * selected turn when it sits outside it. Only when both cannot fit inside
	 * the cap does the requested page win and the selection stay out of view.
	 * This is what the session page uses so `Older`/`Newer` keep advancing.
	 *
	 * When `false`/omitted the legacy selection-anchored behaviour is kept: an
	 * explicit `requestedStart` that leaves the selection out of view is
	 * abandoned and the window shifts onto the selection. Defaulted for the
	 * existing pure-helper contract; production callers pass `true`.
	 */
	honorRequestedStart?: boolean;
}

/**
 * Slice a bounded window out of `turns` (ascending order).
 *
 * - `requestedStart === null` (no `?turnStart=`) anchors the window at the end
 *   (the newest turns), matching "last N turns"; a selection then shifts the
 *   window onto it.
 * - `requestedStart` is clamped to `[0, total - size]` so an out-of-range
 *   request degrades to the first/last page instead of an empty slice.
 * - With `options.honorRequestedStart`, the clamped `requestedStart` stays the
 *   anchor and the window grows toward the selection (bounded at `2 × size`).
 * - Without it, a selection outside the window shifts the window onto it
 *   (legacy; the window stays `<= size` turns).
 */
export function windowTurns(
	turns: readonly TurnSummary[],
	selectedTurnId: string | null,
	requestedStart: number | null,
	size: number = DEFAULT_TURN_WINDOW,
	options: TurnWindowOptions = {}
): TurnWindow {
	const total = turns.length;
	const safeSize = toSize(size);
	const maxStart = Math.max(0, total - safeSize);
	const requested =
		requestedStart === null || !Number.isFinite(requestedStart)
			? null
			: Math.trunc(requestedStart);

	let start = requested === null ? maxStart : Math.min(Math.max(0, requested), maxStart);
	let end = Math.min(total, start + safeSize);

	if (selectedTurnId !== null) {
		const selectedIndex = turns.findIndex((turn) => turn.turnId === selectedTurnId);
		if (selectedIndex >= 0 && (selectedIndex < start || selectedIndex >= end)) {
			const honorRequest = options.honorRequestedStart === true && requested !== null;
			const unionStart = Math.min(start, selectedIndex);
			const unionEnd = Math.min(total, Math.max(end, selectedIndex + 1));
			if (honorRequest && unionEnd - unionStart <= 2 * safeSize) {
				// Grow the requested page just enough to include the selection.
				start = unionStart;
				end = unionEnd;
			} else if (!honorRequest) {
				// Legacy: abandon the request and shift onto the selection.
				start = selectedIndex;
				end = Math.min(total, start + safeSize);
			}
			// honorRequest + too wide: the requested page wins; the selection
			// stays out of view so paging can move away from it.
		}
	}

	return {
		turns: turns.slice(start, end),
		total,
		start,
		end,
		size: safeSize,
		hiddenOlder: start,
		hiddenNewer: total - end,
		hasOlder: start > 0,
		hasNewer: end < total
	};
}

/** Explicit first-turn indices for the session page's Older/Newer controls. */
export interface TurnPageTargets {
	/** `turnStart` for the older page, or `null` when already at the start. */
	older: number | null;
	/** `turnStart` for the newer page, or `null` when already at the end. */
	newer: number | null;
}

/**
 * Derive the `turnStart` values for the `Older`/`Newer` controls from the
 * *rendered* bounds of `window` (never from the pre-shift request), so
 * following a link always advances even when a `?turn=` selection sits at the
 * window edge:
 *
 * - `older = start - size` (clamped to `0`; `null` at the start of the list).
 * - `newer = end` (`null` at the end of the list) — the first turn the current
 *   window hides, which also steps past a window that was grown for a
 *   selection.
 */
export function turnPageTargets(window: TurnWindow): TurnPageTargets {
	return {
		older: window.hasOlder ? Math.max(0, window.start - window.size) : null,
		newer: window.hasNewer ? window.end : null
	};
}
