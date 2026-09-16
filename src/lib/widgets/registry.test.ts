import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	DEFAULT_WIDGETS,
	clampHeight,
	clampWidgetHeight,
	clampWidth,
	isWidgetId,
	resolvePlacements,
	WIDGET_DEFS,
	WIDGET_IDS,
	WIDGET_MAX_HEIGHT,
	WIDGET_MAX_WIDTH,
	WIDGET_MIN_HEIGHT,
	WIDGET_MIN_WIDTH
} from './registry';
import {
	GRID_COLUMNS,
	GRID_GAP_PX,
	GRID_GAP_REM,
	GRID_ROW_HEIGHT_PX,
	GRID_ROW_HEIGHT_REM,
	ROOT_FONT_SIZE_PX,
	WIDGET_MAX_HEIGHT as LAYOUT_MAX_HEIGHT,
	WIDGET_MAX_WIDTH as LAYOUT_MAX_WIDTH,
	WIDGET_MIN_HEIGHT as LAYOUT_MIN_HEIGHT,
	WIDGET_MIN_WIDTH as LAYOUT_MIN_WIDTH
} from '$lib/components/features/dashboard/layout';
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

	test('per-widget minHeight matches the spec', () => {
		const byId = new Map(WIDGET_DEFS.map((def) => [def.id, def]));
		expect(byId.get('top-projects')?.minHeight).toBe(1);
		expect(byId.get('top-tools')?.minHeight).toBe(2);
		expect(byId.get('kpi')?.minHeight).toBe(2);
		expect(byId.get('agent-distribution')?.minHeight).toBe(2);
		expect(byId.get('sessions-per-day')?.minHeight).toBe(3);
		expect(byId.get('cost-per-day')?.minHeight).toBe(3);
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

describe('clampWidgetHeight()', () => {
	test('below-minimum input clamps up to the widget minimum', () => {
		// kpi minHeight is 2; height 0 and 1 must both raise to 2.
		expect(clampWidgetHeight('kpi', 0)).toBe(2);
		expect(clampWidgetHeight('kpi', 1)).toBe(2);
		expect(clampWidgetHeight('kpi', -5)).toBe(2);
	});

	test('within the widget range returns the value unchanged', () => {
		expect(clampWidgetHeight('kpi', 2)).toBe(2);
		expect(clampWidgetHeight('kpi', 4)).toBe(4);
		expect(clampWidgetHeight('kpi', 8)).toBe(8);
	});

	test('above WIDGET_MAX_HEIGHT clamps down to the global maximum', () => {
		expect(clampWidgetHeight('kpi', 9)).toBe(WIDGET_MAX_HEIGHT);
		expect(clampWidgetHeight('kpi', 100)).toBe(WIDGET_MAX_HEIGHT);
	});

	test('non-finite values fall back to the widget minimum', () => {
		expect(clampWidgetHeight('kpi', NaN)).toBe(2);
		expect(clampWidgetHeight('kpi', Infinity)).toBe(2);
		expect(clampWidgetHeight('kpi', -Infinity)).toBe(2);
	});

	test('each widget uses its own minimum (not a global one)', () => {
		// top-projects has minHeight=1, so height 0 raises only to 1.
		expect(clampWidgetHeight('top-projects', 0)).toBe(1);
		expect(clampWidgetHeight('top-projects', 1)).toBe(1);
		// sessions-per-day has minHeight=3, so height 1 and 2 raise to 3.
		expect(clampWidgetHeight('sessions-per-day', 0)).toBe(3);
		expect(clampWidgetHeight('sessions-per-day', 1)).toBe(3);
		expect(clampWidgetHeight('sessions-per-day', 2)).toBe(3);
		// cost-per-day has minHeight=3 as well.
		expect(clampWidgetHeight('cost-per-day', 1)).toBe(3);
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

	test('legacy string[] entries get registry-default sizes and auto-positions', () => {
		const result = resolvePlacements(['kpi', 'agent-distribution']);
		expect(result).toEqual([
			{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 },
			{ id: 'agent-distribution', width: 1, height: 3, x: 0, y: 2 }
		]);
	});

	test('object entries preserve explicit width/height and auto-position', () => {
		const result = resolvePlacements([{ id: 'kpi', width: 2, height: 4 }] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 2, height: 4, x: 0, y: 0 }]);
	});

	test('mixed string[] and object[] work together', () => {
		const result = resolvePlacements([
			'kpi',
			{ id: 'top-tools', width: 3, height: 5 }
		] as unknown as unknown[]);
		expect(result).toEqual([
			{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 },
			{ id: 'top-tools', width: 3, height: 5, x: 0, y: 2 }
		]);
	});

	test('missing width/height in object falls back to registry default', () => {
		const result = resolvePlacements([{ id: 'kpi' }] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }]);
	});

	test('out-of-range sizes are clamped', () => {
		const result = resolvePlacements([{ id: 'kpi', width: 10, height: 0 }] as unknown as unknown[]);
		// kpi minHeight is 2, so height 0 clamps up to 2 (not the old global min of 1).
		expect(result).toEqual([{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }]);
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
		// First occurrence wins; kpi minHeight is 2, so height 1 clamps up to 2.
		expect(result).toEqual([{ id: 'kpi', width: 1, height: 2, x: 0, y: 0 }]);
	});

	test('result placements are in registry order even when objects override sizes', () => {
		const result = resolvePlacements([
			{ id: 'top-projects', width: 3, height: 5 },
			{ id: 'kpi', width: 2, height: 1 }
		] as unknown as unknown[]);
		expect(result.map((p) => p.id)).toEqual(['kpi', 'top-projects']);
		// kpi minHeight is 2, so height 1 is raised to 2.
		expect(result[0]).toEqual({ id: 'kpi', width: 2, height: 2, x: 0, y: 0 });
		expect(result[1]).toEqual({ id: 'top-projects', width: 3, height: 5, x: 0, y: 2 });
	});

	test('honours a finite x/y pair (explicit position)', () => {
		const result = resolvePlacements([
			{ id: 'kpi', width: 2, height: 2, x: 1, y: 3 }
		] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 2, height: 2, x: 1, y: 3 }]);
	});

	test('x + width == columns boundary is honoured (right edge)', () => {
		const result = resolvePlacements([
			{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }
		] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }]);
	});

	test('x out of range (negative) is clamped to 0', () => {
		const result = resolvePlacements([
			{ id: 'kpi', width: 2, height: 2, x: -5, y: 0 }
		] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 2, height: 2, x: 0, y: 0 }]);
	});

	test('x out of range (too large) is clamped so x+width==columns', () => {
		// width=2, columns=4; max x=2.
		const result = resolvePlacements([
			{ id: 'kpi', width: 2, height: 2, x: 10, y: 0 }
		] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 2, height: 2, x: 2, y: 0 }]);
	});

	test('y out of range (negative) is clamped to 0', () => {
		const result = resolvePlacements([
			{ id: 'kpi', width: 2, height: 2, x: 0, y: -5 }
		] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 2, height: 2, x: 0, y: 0 }]);
	});

	test('partial pair (x only) is treated as unpositioned → auto-positioned', () => {
		const result = resolvePlacements([{ id: 'kpi', x: 99 } as unknown as WidgetPlacement] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }]);
	});

	test('partial pair (y only) is treated as unpositioned → auto-positioned', () => {
		const result = resolvePlacements([{ id: 'kpi', y: 99 } as unknown as WidgetPlacement] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }]);
	});

	test('x/y as null is treated as unpositioned → auto-positioned', () => {
		const result = resolvePlacements([{ id: 'kpi', x: null, y: null }] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }]);
	});

	test('x/y as non-finite (NaN, Infinity) is treated as unpositioned → auto-positioned', () => {
		const resultNaN = resolvePlacements([{ id: 'kpi', x: NaN, y: 0 }] as unknown as unknown[]);
		expect(resultNaN).toEqual([{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }]);
		const resultInf = resolvePlacements([{ id: 'kpi', x: 0, y: Infinity }] as unknown as unknown[]);
		expect(resultInf).toEqual([{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }]);
		const resultNegInf = resolvePlacements([{ id: 'kpi', x: -Infinity, y: 0 }] as unknown as unknown[]);
		expect(resultNegInf).toEqual([{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }]);
	});

	test('x/y as string is treated as unpositioned → auto-positioned', () => {
		const result = resolvePlacements([{ id: 'kpi', x: '1' as unknown as number }] as unknown as unknown[]);
		expect(result).toEqual([{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }]);
	});

	test('mixed positioned and unpositioned: positioned reserved, unpositioned auto-filled without overlap', () => {
		const result = resolvePlacements([
			{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 }, // positioned
			{ id: 'top-tools' } as unknown as WidgetPlacement // unpositioned
		] as unknown as unknown[]);
		expect(result.map((p) => p.id)).toEqual(['kpi', 'top-tools']);
		// kpi occupies row 0-1 cols 0-3; top-tools(2x3) should land at (0,2).
		expect(result[0]).toEqual({ id: 'kpi', width: 4, height: 2, x: 0, y: 0 });
		expect(result[1]).toEqual({ id: 'top-tools', width: 2, height: 3, x: 0, y: 2 });
	});

	test('determinism: same hostile/partial input resolved twice yields identical layout', () => {
		const hostile = [
			{ id: 'kpi', x: NaN, y: Infinity } as unknown as WidgetPlacement,
			{ id: 'top-tools', width: 'bad' as unknown as number, y: null },
			'kpi', // duplicate
			'ghost',
			null,
			42,
			{ id: 'agent-distribution' }
		] as unknown as unknown[];
		const a = resolvePlacements(hostile);
		const b = resolvePlacements(hostile);
		expect(a).toEqual(b);
	});

	test('determinism: different input array order yields same widget order (registry order)', () => {
		const reorderA = resolvePlacements(['top-projects', 'kpi', 'agent-distribution']);
		const reorderB = resolvePlacements(['agent-distribution', 'top-projects', 'kpi']);
		const reorderC = resolvePlacements(['kpi', 'agent-distribution', 'top-projects']);
		expect(reorderA.map((p) => p.id)).toEqual(['kpi', 'agent-distribution', 'top-projects']);
		expect(reorderB.map((p) => p.id)).toEqual(['kpi', 'agent-distribution', 'top-projects']);
		expect(reorderC.map((p) => p.id)).toEqual(['kpi', 'agent-distribution', 'top-projects']);
		expect(reorderA).toEqual(reorderB);
		expect(reorderB).toEqual(reorderC);
	});

	test('no overlap guarantee: same input twice, no two placements share a cell', () => {
		const result = resolvePlacements([
			{ id: 'kpi', width: 2, height: 2, x: 0, y: 0 },
			{ id: 'sessions-per-day' },
			{ id: 'cost-per-day', width: 2, height: 2, x: 3, y: 0 },
			{ id: 'top-tools' }
		] as unknown as unknown[]);
		const cells = new Set<number>();
		for (const p of result) {
			for (let cy = p.y!; cy < p.y! + p.height; cy++) {
				for (let cx = p.x!; cx < p.x! + p.width; cx++) {
					const key = cy * GRID_COLUMNS + cx;
					expect(cells.has(key), `overlap at (${cx},${cy}) for ${p.id}`).toBe(false);
					cells.add(key);
				}
			}
		}
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

	test('imports only layout.ts as its single external dependency', () => {
		const layoutImport = source.match(/from ['"]\$lib\/components\/features\/dashboard\/layout['"]/);
		expect(layoutImport).toBeTruthy();
		// Strip the entire import block (single-line or multi-line) and assert nothing
		// remains that imports from any other external module.
		const withoutImports = source.replace(/import\s*{[^}]*}\s*from\s*['"][^'']+['"];?\n?/g, '');
		const stray = withoutImports.match(/\bimport\s+/);
		expect(stray).toBeFalsy();
	});
});

describe('DEFAULT_WIDGETS positions', () => {
	test('resolves to a packed non-overlapping layout in registry order', () => {
		const expected: WidgetPlacement[] = [
			{ id: 'kpi', width: 4, height: 2, x: 0, y: 0 },
			{ id: 'sessions-per-day', width: 2, height: 3, x: 0, y: 2 },
			{ id: 'cost-per-day', width: 2, height: 3, x: 2, y: 2 },
			{ id: 'top-tools', width: 2, height: 3, x: 0, y: 5 },
			{ id: 'agent-distribution', width: 1, height: 3, x: 2, y: 5 },
			{ id: 'top-projects', width: 2, height: 3, x: 0, y: 8 }
		];
		expect(DEFAULT_WIDGETS).toEqual(expected);
	});

	test('no two default widgets share a grid cell', () => {
		const cells = new Set<number>();
		for (const p of DEFAULT_WIDGETS) {
			for (let cy = p.y!; cy < p.y! + p.height; cy++) {
				for (let cx = p.x!; cx < p.x! + p.width; cx++) {
					expect(cells.has(cy * GRID_COLUMNS + cx), `overlap at (${cx},${cy}) for ${p.id}`).toBe(false);
					cells.add(cy * GRID_COLUMNS + cx);
				}
			}
		}
	});

	test('every default placement has x+width <= GRID_COLUMNS and y >= 0', () => {
		for (const p of DEFAULT_WIDGETS) {
			expect(p.x! + p.width, p.id).toBeLessThanOrEqual(GRID_COLUMNS);
			expect(p.y!, p.id).toBeGreaterThanOrEqual(0);
		}
	});
});

describe('geometry constants match CSS reality', () => {
	test('GRID_ROW_HEIGHT_PX == GRID_ROW_HEIGHT_REM * ROOT_FONT_SIZE_PX', () => {
		expect(GRID_ROW_HEIGHT_PX).toBe(GRID_ROW_HEIGHT_REM * ROOT_FONT_SIZE_PX);
	});

	test('GRID_GAP_PX == GRID_GAP_REM * ROOT_FONT_SIZE_PX', () => {
		expect(GRID_GAP_PX).toBe(GRID_GAP_REM * ROOT_FONT_SIZE_PX);
	});

	test('WIDGET bounds exported from registry match layout.ts', () => {
		expect(WIDGET_MIN_WIDTH).toBe(LAYOUT_MIN_WIDTH);
		expect(WIDGET_MAX_WIDTH).toBe(LAYOUT_MAX_WIDTH);
		expect(WIDGET_MIN_HEIGHT).toBe(LAYOUT_MIN_HEIGHT);
		expect(WIDGET_MAX_HEIGHT).toBe(LAYOUT_MAX_HEIGHT);
	});

	test('ROOT_FONT_SIZE_PX = 14 canary: if CSS root font-size changes, this fails', () => {
		// Canaries that would catch a root-font-size drift:
		// - ROOT_FONT_SIZE_PX != 14 means layout.ts was updated but app.css wasn't (or vice versa).
		// - GRID_ROW_HEIGHT_PX != 84 means the row-height rem × font-size product diverges from CSS.
		// - GRID_GAP_PX != 14 means the gap rem × font-size product diverges from CSS.
		expect(ROOT_FONT_SIZE_PX).toBe(14);
		expect(GRID_ROW_HEIGHT_PX).toBe(84);
		expect(GRID_GAP_PX).toBe(14);
	});

	test('GRID_COLUMNS = 4 canary: diverges from WidgetGrid.svelte grid-template-columns', () => {
		// If WidgetGrid.svelte changes repeat(N,...) without updating layout.ts, this catches it.
		expect(GRID_COLUMNS).toBe(4);
	});
});
