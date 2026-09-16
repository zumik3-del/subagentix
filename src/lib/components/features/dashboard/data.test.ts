import { describe, expect, test } from 'bun:test';
import { buildWidgetUrl, defaultIsEmpty } from './data.svelte';
import type { DashboardFilter } from '$lib/model/dashboard';

/**
 * Unit tests for the pure helpers exported by useWidgetData (dashboard Phase 3,
 * task #410). These are exercised by the widget bodies and must stay
 * testable without a component or hydration context.
 */

describe('buildWidgetUrl()', () => {
	const base: DashboardFilter = { period: '30d', scope: null };

	test('includes period and scope=all for a null scope', () => {
		const url = buildWidgetUrl('/api/dashboard/kpi', base, false);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('period')).toBe('30d');
		expect(params.get('scope')).toBe('all');
		expect(params.has('refresh')).toBe(false);
	});

	test('includes the scoped directory when scope is non-null', () => {
		const filter: DashboardFilter = { period: '7d', scope: '/repo/a' };
		const url = buildWidgetUrl('/api/dashboard/top-tools', filter, false);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('period')).toBe('7d');
		expect(params.get('scope')).toBe('/repo/a');
	});

	test('appends ?refresh=1 when refresh is true', () => {
		const url = buildWidgetUrl('/api/dashboard/kpi', base, true);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('refresh')).toBe('1');
	});

	test('refresh flag is independent of period/scope', () => {
		const url = buildWidgetUrl('/api/dashboard/cost-per-day', base, true);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('period')).toBe('30d');
		expect(params.get('scope')).toBe('all');
		expect(params.get('refresh')).toBe('1');
	});

	test('source path is preserved as the base', () => {
		const url = buildWidgetUrl('/api/dashboard/sessions-per-day', base, false);
		expect(url.startsWith('/api/dashboard/sessions-per-day?')).toBe(true);
	});
});

describe('defaultIsEmpty()', () => {
	test('null is empty', () => {
		expect(defaultIsEmpty(null)).toBe(true);
	});

	test('undefined is empty', () => {
		expect(defaultIsEmpty(undefined)).toBe(true);
	});

	test('an empty array is empty', () => {
		expect(defaultIsEmpty([])).toBe(true);
	});

	test('a non-empty array is not empty', () => {
		expect(defaultIsEmpty([1])).toBe(false);
		expect(defaultIsEmpty(['a'])).toBe(false);
	});

	test('a non-null object is not empty (used by top-tools)', () => {
		// top-tools passes a custom isEmpty; defaultIsEmpty should return false
		// for object payloads so it does not incorrectly show the empty state.
		expect(defaultIsEmpty({ tools: [], capped: false })).toBe(false);
		expect(defaultIsEmpty({})).toBe(false);
	});

	test('a non-empty string is not empty', () => {
		expect(defaultIsEmpty('hello')).toBe(false);
	});

	test('zero is not empty (number payloads)', () => {
		expect(defaultIsEmpty(0)).toBe(false);
	});
});

/**
 * Verify data.svelte.ts exports only pure helpers at module level (no fetch
 * call at import time).
 */
describe('data.svelte.ts module-level purity', () => {
	test('buildWidgetUrl and defaultIsEmpty are exported functions', async () => {
		const source = new URL('./data.svelte.ts', import.meta.url);
		const content = await Bun.file(source).text();
		expect(content).toMatch(/export\s+function\s+buildWidgetUrl/);
		expect(content).toMatch(/export\s+function\s+defaultIsEmpty/);
	});

	test('does not statically import uplot or Svelte components', async () => {
		const source = new URL('./data.svelte.ts', import.meta.url);
		const content = await Bun.file(source).text();
		expect(content).not.toMatch(/from ['"]uplot['"]/);
	});
});
