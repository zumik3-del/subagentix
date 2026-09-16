import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	DEFAULT_WIDGETS,
	clampWidth,
	clampHeight,
	isWidgetId,
	resolvePlacements,
	WIDGET_DEFS,
	WIDGET_IDS,
	WIDGET_MAX_HEIGHT,
	WIDGET_MAX_WIDTH,
	WIDGET_MIN_HEIGHT,
	WIDGET_MIN_WIDTH
} from './registry';
import type { WidgetId, WidgetPlacement } from './registry';

/**
 * Unit tests for the dashboard widget registry (dashboard Phase 1, task #402;
 * resizable in #438).
 *
 * The registry is the single shared contract for widget identity, order and
 * default placement, and is imported by both SSR and client code. These tests
 * pin the v1 catalog, the guard behaviour and the server-free/DOM-free source
 * invariant (spec §2.1).
 */

const SPEC_IDS: readonly WidgetId[] = [
	'kpi',
	'sessions-per-day',
	'cost-per-day',
	'top-tools',
	'agent-distribution',
	'top-projects'
];

describe('WIDGET_DEFS', () => {
	test('registers every v1 widget in registry order', () => {
		expect(WIDGET_DEFS.map((def) => def.id)).toEqual([...SPEC_IDS]);
	});

	test('every id is unique', () => {
		const ids = WIDGET_DEFS.map((def) => def.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test('every def has a title, valid numeric width/height, a valid tier and an endpoint source', () => {
		const tiers: Array<'S' | 'M' | 'P'> = ['S', 'M', 'P'];
		for (const def of WIDGET_DEFS) {
			expect(def.title.length, def.id).toBeGreaterThan(0);
			expect(typeof def.width, def.id).toBe('number');
			expect(typeof def.height, def.id).toBe('number');
			expect(tiers, def.id).toContain(def.tier);
			expect(def.source, def.id).toBe(`/api/dashboard/${def.id}`);
		}
	});

	test('kpi is 4x2; agent-distribution is 1x3; the rest are 2x3', () => {
		const byId = new Map(WIDGET_DEFS.map((def) => [def.id, def]));
		expect(byId.get('kpi')?.width).toBe(4);
		expect(byId.get('kpi')?.height).toBe(2);
		expect(byId.get('agent-distribution')?.width).toBe(1);
		expect(byId.get('agent-distribution')?.height).toBe(3);
		for (const id of ['sessions-per-day', 'cost-per-day', 'top-tools', 'top-projects'] as const) {
			expect(byId.get(id)?.width, id).toBe(2);
			expect(byId.get(id)?.height, id).toBe(3);
		}
	});

	test('the optional catalog extensions are not v1 registry entries', () => {
		const ids: readonly string[] = WIDGET_DEFS.map((def) => def.id);
		for (const excluded of ['top-models', 'token-mix', 'activity-heatmap']) {
			expect(ids, excluded).not.toContain(excluded);
		}
	});
});

describe('DEFAULT_WIDGETS', () => {
	test('is the six v1 widgets in registry order as placements', () => {
		expect(DEFAULT_WIDGETS).toHaveLength(6);
		expect(DEFAULT_WIDGETS.map((p) => p.id)).toEqual([...SPEC_IDS]);
		expect(DEFAULT_WIDGETS.map((p) => p.id)).toEqual([...WIDGET_IDS]);
	});

	test('contains only placements whose ids the registry defines', () => {
		for (const placement of DEFAULT_WIDGETS) {
			expect(isWidgetId(placement.id), placement.id).toBe(true);
			expect(typeof placement.width).toBe('number');
			expect(typeof placement.height).toBe('number');
		}
	});
});

describe('isWidgetId()', () => {
	test('accepts every registered id', () => {
		for (const id of WIDGET_IDS) {
			expect(isWidgetId(id), id).toBe(true);
		}
	});

	test('rejects unknown ids, near-misses and non-strings', () => {
		for (const value of ['', 'kpi ', 'KPI', 'top-model', 'sessions_per_day', null, undefined, 1, {}, []]) {
			expect(isWidgetId(value), String(value)).toBe(false);
		}
	});
});

describe('clampWidth()', () => {
	test('clamps to [1, 4] for in-range integers', () => {
		expect(clampWidth(1)).toBe(1);
		expect(clampWidth(2)).toBe(2);
		expect(clampWidth(3)).toBe(3);
		expect(clampWidth(4)).toBe(4);
	});

	test('clamps out-of-range integers to the nearest bound', () => {
		expect(clampWidth(0)).toBe(1);
		expect(clampWidth(-5)).toBe(1);
		expect(clampWidth(5)).toBe(4);
		expect(clampWidth(100)).toBe(4);
	});

	test('rounds floats and clamps', () => {
		expect(clampWidth(2.4)).toBe(2);
		expect(clampWidth(2.6)).toBe(3);
		// 0.4 rounds to 0, which is then clamped up to the minimum of 1.
		expect(clampWidth(0.4)).toBe(1);
	});

	test('non-finite values fall back to minimum', () => {
		expect(clampWidth(NaN)).toBe(WIDGET_MIN_WIDTH);
		expect(clampWidth(Infinity)).toBe(WIDGET_MIN_WIDTH);
		expect(clampWidth(-Infinity)).toBe(WIDGET_MIN_WIDTH);
	});
});

describe('clampHeight()', () => {
	test('clamps to [1, 8] for in-range integers', () => {
		expect(clampHeight(1)).toBe(1);
		expect(clampHeight(4)).toBe(4);
		expect(clampHeight(8)).toBe(8);
	});

	test('clamps out-of-range integers to the nearest bound', () => {
		expect(clampHeight(0)).toBe(1);
		expect(clampHeight(-10)).toBe(1);
		expect(clampHeight(9)).toBe(8);
		expect(clampHeight(100)).toBe(8);
	});

	test('non-finite values fall back to minimum', () => {
		expect(clampHeight(NaN)).toBe(WIDGET_MIN_HEIGHT);
		expect(clampHeight(Infinity)).toBe(WIDGET_MIN_HEIGHT);
		expect(clampHeight(-Infinity)).toBe(WIDGET_MIN_HEIGHT);
	});
});

describe('resolvePlacements()', () => {
	test('returns registry order regardless of input order', () => {
		const result = resolvePlacements(['top-projects', 'kpi', 'cost-per-day']);
		expect(result.map((p) => p.id)).toEqual(['kpi', 'cost-per-day', 'top-projects']);
	});

	test('drops unknown ids and dedupes (first wins)', () => {
		const result = resolvePlacements(['kpi', 'ghost', 'kpi', 'top-tools', '']);
		expect(result.map((p) => p.id)).toEqual(['kpi', 'top-tools']);
	});

	test('empty or all-unknown input yields no widgets', () => {
		expect(resolvePlacements([])).toEqual([]);
		expect(resolvePlacements(['ghost', 'nope'])).toEqual([]);
	});

	test('returns the full registry for every registered id', () => {
		const result = resolvePlacements([...WIDGET_IDS].reverse());
		expect(result.map((p) => p.id)).toEqual([...WIDGET_IDS]);
	});

	test('does not mutate the input array', () => {
		const input = ['top-tools', 'kpi'];
		resolvePlacements(input);
		expect(input).toEqual(['top-tools', 'kpi']);
	});

	test('legacy string[] entries get registry-default sizes', () => {
		const result = resolvePlacements(['kpi', 'agent-distribution']);
		expect(result).toEqual([
			{ id: 'kpi', width: 4, height: 2 },
			{ id: 'agent-distribution', width: 1, height: 3 }
		]);
	});

	test('object entries preserve explicit width/height', () => {
		const result = resolvePlacements([
			{ id: 'kpi', width: 2, height: 4 }
		] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 2, height: 4 }]);
	});

	test('mixed string[] and object[] work together', () => {
		const result = resolvePlacements([
			'kpi',
			{ id: 'top-tools', width: 3, height: 5 }
		] as unknown as unknown[]);
		expect(result).toEqual([
			{ id: 'kpi', width: 4, height: 2 },
			{ id: 'top-tools', width: 3, height: 5 }
		]);
	});

	test('missing width/height in object falls back to registry default', () => {
		const result = resolvePlacements([{ id: 'kpi' }] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 4, height: 2 }]);
	});

	test('out-of-range sizes are clamped', () => {
		const result = resolvePlacements([{ id: 'kpi', width: 10, height: 0 }] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 4, height: 1 }]);
	});

	test('non-array input returns empty array', () => {
		expect(resolvePlacements(null as unknown as unknown[])).toEqual([]);
		expect(resolvePlacements('kpi' as unknown as unknown[])).toEqual([]);
		expect(resolvePlacements({ id: 'kpi' } as unknown as unknown[])).toEqual([]);
	});

	test('non-object/non-string entries in array are dropped', () => {
		const result = resolvePlacements(['kpi', 42, null, true] as unknown as unknown[]);
		expect(result.map((p) => p.id)).toEqual(['kpi']);
	});

	test('duplicate ids collapse to first occurrence', () => {
		const result = resolvePlacements([
			{ id: 'kpi', width: 1, height: 1 },
			{ id: 'kpi', width: 4, height: 8 }
		] as unknown as unknown[]);
		// First occurrence wins.
		expect(result).toEqual([{ id: 'kpi', width: 1, height: 1 }]);
	});

	test('result placements are in registry order even when objects override sizes', () => {
		const result = resolvePlacements([
			{ id: 'top-projects', width: 3, height: 5 },
			{ id: 'kpi', width: 2, height: 1 }
		] as unknown as unknown[]);
		expect(result.map((p) => p.id)).toEqual(['kpi', 'top-projects']);
		expect(result[0]).toEqual({ id: 'kpi', width: 2, height: 1 });
		expect(result[1]).toEqual({ id: 'top-projects', width: 3, height: 5 });
	});
});

describe('registry source stays server-free and DOM-free (spec §2.1)', () => {
	const source = readFileSync(new URL('./registry.ts', import.meta.url), 'utf8');

	test('does not import $lib/server, bun:sqlite, Svelte or the DOM', () => {
		expect(source).not.toMatch(/from ['"]\$lib\/server/);
		expect(source).not.toMatch(/from ['"]bun:sqlite/);
		expect(source).not.toMatch(/from ['"]svelte/);
		expect(source).not.toMatch(/\bdocument\.|\bwindow\./);
	});

	test('is a pure module: no runtime imports at all', () => {
		expect(source).not.toMatch(/^\s*import\s/m);
	});
});
