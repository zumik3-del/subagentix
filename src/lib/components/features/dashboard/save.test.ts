import { describe, expect, test } from 'bun:test';
import {
	createCoalescingWriter,
	saveDashboardWidgets,
	saveDashboardFilter,
	saveDashboardWidgetSettings
} from './save';
import type { WidgetPlacement } from '$lib/widgets/registry';
import type { DashboardFilter } from '$lib/model/dashboard';
import type { WidgetId, WidgetSettingValues } from '$lib/widgets/registry';

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
		// kpi minHeight is 4 (doubled from old 2); height 3 is clamped up to 4.
		expect(result[0].height).toBe(4);
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

// --- saveDashboardFilter ------------------------------------------------------

describe('saveDashboardFilter()', () => {
	test('returns the server-normalised filter on a successful PUT', async () => {
		const filter: DashboardFilter = { period: '7d', scope: '/repo/a' };
		const stub = async () =>
			new Response(
				JSON.stringify({
					dashboardFilter: { period: '7d', scope: '/repo/a' }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		const result = await saveDashboardFilter(filter, stub as unknown as typeof fetch);
		expect(result).toEqual(filter);
	});

	test('falls back to the sent filter when the server response omits dashboardFilter', async () => {
		const filter: DashboardFilter = { period: '30d', scope: null };
		const stub = async () =>
			new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
		const result = await saveDashboardFilter(filter, stub as unknown as typeof fetch);
		expect(result).toEqual(filter);
	});

	test('falls back to the sent filter when the server returns a malformed dashboardFilter', async () => {
		const filter: DashboardFilter = { period: '7d', scope: '/repo/a' };
		const stub = async () =>
			new Response(
				JSON.stringify({ dashboardFilter: { period: 'invalid', scope: 42 } }),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		const result = await saveDashboardFilter(filter, stub as unknown as typeof fetch);
		// savedFilter rejects invalid period (falls back to sent.period) and non-string scope (falls back to null).
		expect(result).toEqual({ period: '7d', scope: null });
	});

	test('throws an Error carrying the server error on non-OK response', async () => {
		const filter: DashboardFilter = { period: '7d', scope: null };
		const stub = async () =>
			new Response(
				JSON.stringify({ error: 'rate limited' }),
				{ status: 429, headers: { 'content-type': 'application/json' } }
			);
		await expect(saveDashboardFilter(filter, stub as unknown as typeof fetch)).rejects.toThrow(/rate limited/);
	});

	test('falls back to a status-based message when the non-OK body is not JSON', async () => {
		const filter: DashboardFilter = { period: '7d', scope: null };
		const stub = async () => new Response('internal server error', { status: 500 });
		await expect(saveDashboardFilter(filter, stub as unknown as typeof fetch)).rejects.toThrow(/500/);
	});
});

// --- createCoalescingWriter with DashboardFilter ------------------------------

describe('createCoalescingWriter() with DashboardFilter', () => {
	test('rapid selector changes collapse into one trailing save with the latest filter', async () => {
		const calls: DashboardFilter[] = [];
		function save(filter: DashboardFilter): void | Promise<void> {
			calls.push({ ...filter });
			return new Promise<void>((resolve) => setTimeout(resolve, 50));
		}

		const writer = createCoalescingWriter<DashboardFilter>(save);
		const base: DashboardFilter = { period: '7d', scope: null };

		writer.push(base);
		writer.push({ period: '30d', scope: '/a' });
		writer.push({ period: '90d', scope: '/b' });
		writer.push({ period: 'all', scope: null });

		await writer.idle();
		expect(calls).toHaveLength(2);
		expect(calls[0]!).toEqual(base);
		expect(calls[1]!).toEqual({ period: 'all', scope: null });
	});

	test('a rejected filter save is swallowed; later pushes still proceed', async () => {
		const calls: DashboardFilter[] = [];
		let run = 0;
		function save(filter: DashboardFilter): void | Promise<void> {
			calls.push({ ...filter });
			run++;
			if (run === 1) return Promise.reject(new Error('save failed'));
			return Promise.resolve();
		}

		const writer = createCoalescingWriter<DashboardFilter>(save);
		const base: DashboardFilter = { period: '7d', scope: null };

		writer.push(base);
		await Bun.sleep(10);
		writer.push({ period: '30d', scope: '/x' });
		await writer.idle();

		expect(calls).toHaveLength(2);
		expect(calls[0]!).toEqual(base);
		expect(calls[1]!).toEqual({ period: '30d', scope: '/x' });
	});

	test('an idle writer with no filter changes issues no request', async () => {
		const calls: DashboardFilter[] = [];
		function save(_filter: DashboardFilter): void | Promise<void> {
			calls.push({ period: '7d', scope: null });
		}

		const writer = createCoalescingWriter(save);
		await writer.idle();
		expect(calls).toHaveLength(0);
	});
});

// --- saveDashboardWidgetSettings ----------------------------------------------

describe('saveDashboardWidgetSettings()', () => {
	test('returns the server-normalised map on a successful PUT', async () => {
		const all: Record<import('$lib/widgets/registry').WidgetId, import('$lib/widgets/registry').WidgetSettingValues> = {
			'top-tools': { basic: false, mcp: true },
			kpi: {},
			'sessions-per-day': {},
			'cost-per-day': {},
			'agent-distribution': {},
			'top-projects': {}
		};
		const stub = async () =>
			new Response(
				JSON.stringify({ dashboardWidgetSettings: all }),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		const result = await saveDashboardWidgetSettings(all, stub as unknown as typeof fetch);
		expect(result).toEqual(all);
	});

	test('falls back to the sent map when the server response omits dashboardWidgetSettings', async () => {
		const all: Record<import('$lib/widgets/registry').WidgetId, import('$lib/widgets/registry').WidgetSettingValues> = {
			'top-tools': { basic: true, mcp: false },
			kpi: {},
			'sessions-per-day': {},
			'cost-per-day': {},
			'agent-distribution': {},
			'top-projects': {}
		};
		const stub = async () =>
			new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
		const result = await saveDashboardWidgetSettings(all, stub as unknown as typeof fetch);
		expect(result).toEqual(all);
	});

	test('throws an Error carrying the server error on non-OK response', async () => {
		const all: Record<import('$lib/widgets/registry').WidgetId, import('$lib/widgets/registry').WidgetSettingValues> = {
			'top-tools': { basic: true },
			kpi: {},
			'sessions-per-day': {},
			'cost-per-day': {},
			'agent-distribution': {},
			'top-projects': {}
		};
		const stub = async () =>
			new Response(
				JSON.stringify({ error: 'quota exceeded' }),
				{ status: 413, headers: { 'content-type': 'application/json' } }
			);
		await expect(saveDashboardWidgetSettings(all, stub as unknown as typeof fetch)).rejects.toThrow(/quota exceeded/);
	});

	test('falls back to a status-based message when the non-OK body is not JSON', async () => {
		const all: Record<import('$lib/widgets/registry').WidgetId, import('$lib/widgets/registry').WidgetSettingValues> = {
			'top-tools': { basic: true },
			kpi: {},
			'sessions-per-day': {},
			'cost-per-day': {},
			'agent-distribution': {},
			'top-projects': {}
		};
		const stub = async () => new Response('internal server error', { status: 500 });
		await expect(saveDashboardWidgetSettings(all, stub as unknown as typeof fetch)).rejects.toThrow(/500/);
	});
});
