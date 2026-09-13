import { describe, expect, test } from 'bun:test';
import { DEFAULT_TURN_WINDOW, turnPageTargets, windowTurns } from './paging';
import type { TurnSummary } from './types';

/**
 * Unit tests for the pure M4b turn-window helper (task #201/#202).
 *
 * No DB and no server imports: `paging.ts` is imported by the client-side
 * session page, so it must stay deterministic and side-effect free. These tests
 * pin the default/last window, the `turnStart` clamp boundaries, the
 * selection-is-always-visible guarantee, degenerate sizes/lists and the
 * no-mutation contract.
 */

function makeTurns(count: number): TurnSummary[] {
	return Array.from({ length: count }, (_, i) => ({
		turnId: `u${i}`,
		index: i + 1,
		startedAt: 1_700_000_000_000 + i * 1_000,
		assistantCount: 1
	}));
}

describe('windowTurns — default size and anchoring', () => {
	test('exports a default window of 50', () => {
		expect(DEFAULT_TURN_WINDOW).toBe(50);
	});

	test('renders the whole list when it is shorter than the default size', () => {
		const turns = makeTurns(5);
		const window = windowTurns(turns, null, null);

		expect(window.start).toBe(0);
		expect(window.end).toBe(5);
		expect(window.total).toBe(5);
		expect(window.size).toBe(DEFAULT_TURN_WINDOW);
		expect(window.turns).toHaveLength(5);
		expect(window.turns[0]).toBe(turns[0]);
		expect(window.hiddenOlder).toBe(0);
		expect(window.hiddenNewer).toBe(0);
		expect(window.hasOlder).toBe(false);
		expect(window.hasNewer).toBe(false);
	});

	test('anchors the default window at the newest turns (last N)', () => {
		const window = windowTurns(makeTurns(120), null, null);

		expect(window.start).toBe(70);
		expect(window.end).toBe(120);
		expect(window.turns).toHaveLength(50);
		expect(window.turns[0].turnId).toBe('u70');
		expect(window.turns.at(-1)?.turnId).toBe('u119');
		expect(window.hiddenOlder).toBe(70);
		expect(window.hiddenNewer).toBe(0);
		expect(window.hasOlder).toBe(true);
		expect(window.hasNewer).toBe(false);
	});

	test('honours an explicit requestedStart', () => {
		const window = windowTurns(makeTurns(120), null, 10);
		expect(window.start).toBe(10);
		expect(window.end).toBe(60);
		expect(window.turns[0].turnId).toBe('u10');
		expect(window.hasOlder).toBe(true);
		expect(window.hasNewer).toBe(true);
	});

	test('honours an explicit window size', () => {
		const first = windowTurns(makeTurns(10), null, 0, 3);
		expect(first.start).toBe(0);
		expect(first.end).toBe(3);
		expect(first.size).toBe(3);
		expect(first.hasNewer).toBe(true);

		const last = windowTurns(makeTurns(10), null, null, 3);
		expect(last.start).toBe(7);
		expect(last.end).toBe(10);
		expect(last.hasOlder).toBe(true);
		expect(last.hasNewer).toBe(false);
	});
});

describe('windowTurns — requestedStart boundaries and clamping', () => {
	test('clamps a negative requestedStart to 0', () => {
		const window = windowTurns(makeTurns(120), null, -10);
		expect(window.start).toBe(0);
		expect(window.end).toBe(50);
		expect(window.hasOlder).toBe(false);
		expect(window.hasNewer).toBe(true);
	});

	test('accepts requestedStart = 0', () => {
		const window = windowTurns(makeTurns(120), null, 0);
		expect(window.start).toBe(0);
		expect(window.end).toBe(50);
	});

	test('clamps a requestedStart beyond the end to the last page', () => {
		const window = windowTurns(makeTurns(120), null, 500);
		expect(window.start).toBe(70);
		expect(window.end).toBe(120);
		expect(window.hasOlder).toBe(true);
		expect(window.hasNewer).toBe(false);
	});

	test('clamps requestedStart = total - 1 to the last full page', () => {
		const window = windowTurns(makeTurns(120), null, 119);
		expect(window.start).toBe(70);
		expect(window.end).toBe(120);
	});

	test('accepts requestedStart exactly at the last page start', () => {
		const window = windowTurns(makeTurns(120), null, 70);
		expect(window.start).toBe(70);
		expect(window.end).toBe(120);
	});

	test('truncates a fractional requestedStart', () => {
		const window = windowTurns(makeTurns(120), null, 30.9);
		expect(window.start).toBe(30);
		expect(window.end).toBe(80);
	});

	test('falls back to the last page for a non-finite requestedStart', () => {
		const window = windowTurns(makeTurns(120), null, Number.NaN);
		expect(window.start).toBe(70);
		expect(window.end).toBe(120);
	});
});

describe('windowTurns — the selected turn is always inside the window', () => {
	test('shifts the window forward when the selection is newer than it', () => {
		const window = windowTurns(makeTurns(120), 'u99', 0);
		expect(window.start).toBe(99);
		expect(window.end).toBe(120);
		expect(window.turns).toHaveLength(21);
		expect(window.turns.map((turn) => turn.turnId)).toContain('u99');
		expect(window.hasNewer).toBe(false);
		expect(window.hasOlder).toBe(true);
	});

	test('shifts the window backward when the selection is older than it', () => {
		const window = windowTurns(makeTurns(120), 'u5', 70);
		expect(window.start).toBe(5);
		expect(window.end).toBe(55);
		expect(window.turns).toHaveLength(50);
		expect(window.turns.map((turn) => turn.turnId)).toContain('u5');
		expect(window.hiddenOlder).toBe(5);
		expect(window.hiddenNewer).toBe(65);
	});

	test('keeps an already-visible selection in place (deep inside the window)', () => {
		const window = windowTurns(makeTurns(120), 'u25', 20);
		expect(window.start).toBe(20);
		expect(window.end).toBe(70);
	});

	test('keeps a selection on the first rendered index in place', () => {
		const window = windowTurns(makeTurns(120), 'u20', 20);
		expect(window.start).toBe(20);
		expect(window.turns[0].turnId).toBe('u20');
	});

	test('keeps a selection on the last rendered index in place', () => {
		const window = windowTurns(makeTurns(120), 'u69', 20);
		expect(window.start).toBe(20);
		expect(window.turns.at(-1)?.turnId).toBe('u69');
	});

	test('shifts by one when the selection is just past the last rendered index', () => {
		const window = windowTurns(makeTurns(120), 'u70', 20);
		expect(window.start).toBe(70);
		expect(window.turns[0].turnId).toBe('u70');
	});

	test('shifts by one when the selection is just before the first rendered index', () => {
		const window = windowTurns(makeTurns(120), 'u19', 20);
		expect(window.start).toBe(19);
		expect(window.turns[0].turnId).toBe('u19');
	});

	test('ignores a selected id that is not in the session', () => {
		const window = windowTurns(makeTurns(120), 'does-not-exist', 0);
		expect(window.start).toBe(0);
		expect(window.end).toBe(50);
	});

	test('the selection overrides the default last-page anchor', () => {
		const window = windowTurns(makeTurns(120), 'u10', null);
		expect(window.start).toBe(10);
		expect(window.end).toBe(60);
		expect(window.turns.map((turn) => turn.turnId)).toContain('u10');
	});
});

describe('windowTurns — degenerate inputs', () => {
	test('handles an empty turn list', () => {
		const window = windowTurns([], null, null);
		expect(window.total).toBe(0);
		expect(window.start).toBe(0);
		expect(window.end).toBe(0);
		expect(window.size).toBe(DEFAULT_TURN_WINDOW);
		expect(window.turns).toEqual([]);
		expect(window.hiddenOlder).toBe(0);
		expect(window.hiddenNewer).toBe(0);
		expect(window.hasOlder).toBe(false);
		expect(window.hasNewer).toBe(false);
	});

	test('keeps an empty list stable under a requested start and a selection', () => {
		const window = windowTurns([], 'u1', 5);
		expect(window.start).toBe(0);
		expect(window.end).toBe(0);
		expect(window.turns).toEqual([]);
	});

	test('never asks SQLite for a zero/negative page size', () => {
		for (const size of [0, -5, 0.4]) {
			const window = windowTurns(makeTurns(10), null, null, size);
			expect(window.size).toBe(1);
			expect(window.turns).toHaveLength(1);
		}
	});

	test('falls back to the default size for a non-finite size', () => {
		const window = windowTurns(makeTurns(10), null, null, Number.NaN);
		expect(window.size).toBe(DEFAULT_TURN_WINDOW);
	});

	test('truncates a fractional size and tolerates a size larger than the list', () => {
		expect(windowTurns(makeTurns(10), null, null, 3.9).size).toBe(3);
		const huge = windowTurns(makeTurns(10), null, null, 999);
		expect(huge.size).toBe(999);
		expect(huge.turns).toHaveLength(10);
		expect(huge.start).toBe(0);
		expect(huge.end).toBe(10);
	});
});

describe('windowTurns — no mutation', () => {
	test('returns a new array and leaves the input untouched', () => {
		const turns = makeTurns(5);
		const snapshot = JSON.stringify(turns);
		const window = windowTurns(turns, 'u3', 1, 2);

		expect(window.turns).not.toBe(turns);
		expect(JSON.stringify(turns)).toBe(snapshot);
		expect(window.turns.map((turn) => turn.turnId)).toEqual(['u3', 'u4']);
	});

	test('mutating the returned slice does not affect the input list', () => {
		const turns = makeTurns(5);
		const window = windowTurns(turns, null, 0, 3);
		window.turns.pop();

		expect(turns).toHaveLength(5);
		expect(turns.map((turn) => turn.turnId)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4']);
	});
});

/**
 * `honorRequestedStart` is the #204 contract used by the session page: an
 * explicit `?turnStart=` stays authoritative and the window is grown (never
 * abandoned) toward an out-of-view `?turn=` while it fits within `2 × size`;
 * when both cannot fit, the requested page wins so paging can move away.
 */
describe('windowTurns — honorRequestedStart (M4b #204)', () => {
	test('keeps an explicit requestedStart when the selection is already visible', () => {
		const window = windowTurns(makeTurns(120), 'u25', 20, 50, { honorRequestedStart: true });

		expect(window.start).toBe(20);
		expect(window.end).toBe(70);
		expect(window.turns).toHaveLength(50);
	});

	test('unions toward an older out-of-view selection instead of abandoning the request', () => {
		const window = windowTurns(makeTurns(120), 'u5', 20, 50, { honorRequestedStart: true });

		expect(window.start).toBe(5);
		expect(window.end).toBe(70);
		expect(window.turns).toHaveLength(65);
		expect(window.turns[0].turnId).toBe('u5');
		expect(window.turns.at(-1)?.turnId).toBe('u69');
	});

	test('grows toward a newer out-of-view selection', () => {
		const window = windowTurns(makeTurns(120), 'u85', 20, 50, { honorRequestedStart: true });

		expect(window.start).toBe(20);
		expect(window.end).toBe(86);
		expect(window.turns.at(-1)?.turnId).toBe('u85');
	});

	test('allows a union exactly at the 2x size cap', () => {
		const window = windowTurns(makeTurns(120), 'u0', 50, 50, { honorRequestedStart: true });

		expect(window.start).toBe(0);
		expect(window.end).toBe(100);
		expect(window.turns).toHaveLength(2 * 50);
		expect(window.turns.map((turn) => turn.turnId)).toContain('u0');
	});

	test('the requested page wins when the union would exceed the 2x cap', () => {
		const window = windowTurns(makeTurns(120), 'u0', 51, 50, { honorRequestedStart: true });

		expect(window.start).toBe(51);
		expect(window.end).toBe(101);
		expect(window.turns).toHaveLength(50);
		expect(window.turns.map((turn) => turn.turnId)).not.toContain('u0');
	});

	test('keeps the window bounded at 2x for a far selection at the request boundary', () => {
		const window = windowTurns(makeTurns(120), 'u119', 0, 50, { honorRequestedStart: true });

		expect(window.start).toBe(0);
		expect(window.end).toBe(50);
		expect(window.turns).toHaveLength(50);
		expect(window.turns.map((turn) => turn.turnId)).not.toContain('u119');
	});

	test('falls back to the selection-anchored shift when requestedStart is absent', () => {
		const window = windowTurns(makeTurns(120), 'u5', null, 50, { honorRequestedStart: true });

		expect(window.start).toBe(5);
		expect(window.end).toBe(55);
		expect(window.turns).toHaveLength(50);
	});

	test('honors an in-range selection at the first page edge', () => {
		const window = windowTurns(makeTurns(120), 'u0', 0, 50, { honorRequestedStart: true });

		expect(window.start).toBe(0);
		expect(window.end).toBe(50);
		expect(window.turns[0].turnId).toBe('u0');
	});

	test('honors an in-range selection at the last page edge', () => {
		const window = windowTurns(makeTurns(120), 'u119', null, 50, { honorRequestedStart: true });

		expect(window.start).toBe(70);
		expect(window.end).toBe(120);
		expect(window.turns.at(-1)?.turnId).toBe('u119');
	});

	test('never drops or duplicates turns in a union window', () => {
		const window = windowTurns(makeTurns(120), 'u5', 20, 50, { honorRequestedStart: true });
		const ids = window.turns.map((turn) => turn.turnId);

		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(Array.from({ length: 65 }, (_, i) => `u${5 + i}`));
		expect(window.start).toBe(5);
		expect(window.end).toBe(70);
	});
});

/** `turnPageTargets` turns the rendered bounds into the pager's link targets. */
describe('turnPageTargets (M4b #204)', () => {
	test('derives older from the rendered start and newer from the rendered end', () => {
		const window = windowTurns(makeTurns(120), null, 10);

		expect(window.start).toBe(10);
		expect(window.end).toBe(60);
		expect(turnPageTargets(window)).toEqual({ older: 0, newer: 60 });
	});

	test('nulls the older target on the first page', () => {
		const targets = turnPageTargets(windowTurns(makeTurns(120), null, 0));

		expect(targets.older).toBeNull();
		expect(targets.newer).toBe(50);
	});

	test('nulls the newer target on the last page', () => {
		const targets = turnPageTargets(windowTurns(makeTurns(120), null, 70));

		expect(targets.newer).toBeNull();
		expect(targets.older).toBe(20);
	});

	test('clamps the older target to zero when the rendered start is below size', () => {
		const window = windowTurns(makeTurns(120), null, 10);

		expect(turnPageTargets(window).older).toBe(0);
	});

	test('derives both targets from a grown window, not from the request', () => {
		const window = windowTurns(makeTurns(120), 'u5', 20, 50, { honorRequestedStart: true });

		expect(window.start).toBe(5);
		expect(window.end).toBe(70);
		expect(turnPageTargets(window)).toEqual({ older: 0, newer: 70 });
	});

	test('steps past a window grown for a selection (newer = end, not start + size)', () => {
		const window = windowTurns(makeTurns(174), 'u0', 50, 50, { honorRequestedStart: true });

		expect(window.start).toBe(0);
		expect(window.end).toBe(100);
		expect(turnPageTargets(window)).toEqual({ older: null, newer: 100 });
	});

	test('returns nulls for an empty window', () => {
		expect(turnPageTargets(windowTurns([], null, null))).toEqual({ older: null, newer: null });
	});
});
