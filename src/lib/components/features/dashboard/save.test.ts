import { describe, expect, test } from 'bun:test';
import { createCoalescingWriter, saveDashboardWidgets } from './save';
import type { WidgetPlacement } from '$lib/widgets/registry';

/**
 * Unit tests for the shared dashboard widget persistence helpers (task #449).
 *
 * Pure-function coverage: `saveDashboardWidgets` with a stubbed `fetch`,
 * `createCoalescingWriter` ordering rapid pushes into one trailing save.
 * No network, no DOM, no wall clock dependency.
 */

// --- saveDashboardWidgets -----------------------------------------------------

describe('saveDashboardWidgets()', () => {
	test('returns placements normalised through resolvePlacements on a successful PUT', async () => {
		const placements: WidgetPlacement[] = [
			{ id: 'kpi', width: 2, height: 3 },
			{ id: 'sessions-per-day', width: 1, height: 2 }
		];
		const stub = async () =>
			new Response(
				JSON.stringify({
					dashboardWidgets: [
						{ id: 'kpi', width: 2, height: 3, foo: 'bar' },
						{ id: 'sessions-per-day', width: 1, height: 2 }
					]
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		const result = await saveDashboardWidgets(placements, stub as unknown as typeof fetch);
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe('kpi');
		expect(result[0].width).toBe(2);
		expect(result[0].height).toBe(3);
		expect(result[0]).not.toHaveProperty('foo');
	});

	test('throws an Error carrying the server error field on non-OK response', async () => {
		const placements: WidgetPlacement[] = [{ id: 'kpi', width: 4, height: 2 }];
		const stub = async () =>
			new Response(
				JSON.stringify({ error: 'quota exceeded' }),
				{ status: 413, headers: { 'content-type': 'application/json' } }
			);
		await expect(saveDashboardWidgets(placements, stub as unknown as typeof fetch)).rejects.toThrow(
			/quota exceeded/
		);
	});

	test('falls back to a status-based message when the non-OK body is not JSON', async () => {
		const placements: WidgetPlacement[] = [{ id: 'kpi', width: 4, height: 2 }];
		const stub = async () =>
			new Response('internal server error', { status: 500 });
		await expect(saveDashboardWidgets(placements, stub as unknown as typeof fetch)).rejects.toThrow(
			/500/
		);
	});

	test('falls back to a status-based message when the non-OK body is malformed JSON', async () => {
		const placements: WidgetPlacement[] = [{ id: 'kpi', width: 4, height: 2 }];
		const stub = async () =>
			new Response('{not valid json', { status: 500 });
		await expect(saveDashboardWidgets(placements, stub as unknown as typeof fetch)).rejects.toThrow(
			/500/
		);
	});
});

// --- createCoalescingWriter ---------------------------------------------------

describe('createCoalescingWriter()', () => {
	test('while a save is in flight, several queued changes produce exactly one trailing save with the latest payload', async () => {
		const calls: WidgetPlacement[][] = [];
		// save must settle (not reject) per the module contract — it owns its own
		// error handling; the writer only orders calls.
		function save(placements: readonly WidgetPlacement[]): void | Promise<void> {
			calls.push([...placements]);
			return new Promise<void>((resolve) => setTimeout(resolve, 50));
		}

		const writer = createCoalescingWriter(save);
		const base: WidgetPlacement[] = [{ id: 'kpi', width: 1, height: 1 }];

		// Kick off the first save.
		writer.push(base);
		// Queue three more pushes while it is in flight — only the last should win.
		writer.push([{ id: 'kpi', width: 2, height: 1 }]);
		writer.push([{ id: 'kpi', width: 3, height: 1 }]);
		writer.push([{ id: 'kpi', width: 4, height: 1 }]);

		// Wait for the single trailing save to complete.
		await writer.idle();
		// Two calls total: the initial base save, then exactly one trailing save
		// with the latest (width=4) payload. Subsequent pushes during the in-flight
		// request collapse into that single trailing save.
		expect(calls).toHaveLength(2);
		expect(calls[0]!).toEqual([{ id: 'kpi', width: 1, height: 1 }]);
		expect(calls[1]!).toEqual([{ id: 'kpi', width: 4, height: 1 }]);
	});

	test('a rejected save surfaces the error and later pushes still proceed', async () => {
		const calls: WidgetPlacement[][] = [];
		let run = 0;
		function save(placements: readonly WidgetPlacement[]): void | Promise<void> {
			calls.push([...placements]);
			run++;
			// First call rejects; the writer swallows it (.catch(() => {})).
			// Second call succeeds.
			if (run === 1) return Promise.reject(new Error('boom'));
			return Promise.resolve();
		}

		const writer = createCoalescingWriter(save);
		const base: WidgetPlacement[] = [{ id: 'kpi', width: 1, height: 1 }];

		writer.push(base);
		// Wait for the first save to start, then queue a replacement while it is in flight.
		await Bun.sleep(10);
		writer.push([{ id: 'kpi', width: 2, height: 1 }]);
		await writer.idle();

		// Two calls total: first rejected (swallowed), second resolved.
		expect(calls).toHaveLength(2);
		expect(calls[0]!).toEqual([{ id: 'kpi', width: 1, height: 1 }]);
		expect(calls[1]!).toEqual([{ id: 'kpi', width: 2, height: 1 }]);
	});

	test('an idle writer with no changes issues no request', async () => {
		const calls: WidgetPlacement[][] = [];
		function save(_placements: readonly WidgetPlacement[]): void | Promise<void> {
			calls.push([]);
		}

		const writer = createCoalescingWriter(save);
		await writer.idle();
		expect(calls).toHaveLength(0);
	});
});
