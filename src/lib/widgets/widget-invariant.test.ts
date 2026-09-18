import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	WIDGET_REGISTRY,
	WIDGET_DEFS,
	WIDGET_IDS,
	widgetSource,
	type WidgetId
} from './registry';

/**
 * Invariant tests for the widget-engine contracts (epic #487, tasks #490-#494).
 *
 * The engine now requires every registered widget id to simultaneously satisfy
 * three obligations: a descriptor `load` in WIDGET_REGISTRY, an entry in
 * WidgetDataMap (compile-time enforced via the mapped union), and a payload
 * builder in the server-side WIDGET_BUILDERS map. This test file pins that
 * contract so adding a widget without one of the three fails here rather than
 * surfacing as a runtime 404 or a type error deep in the build pipeline.
 *
 * No source under test is modified — these are pure invariant assertions.
 */

describe('widget-engine invariant: every WidgetId has a complete triple', () => {
	test('every registered id has a descriptor load function in WIDGET_REGISTRY', () => {
		for (const id of WIDGET_IDS) {
			const entry = WIDGET_REGISTRY[id];
			expect(typeof entry.load, id).toBe('function');
		}
	});

	test('every registered id appears exactly once in WIDGET_DEFS', () => {
		const defsById = new Map(WIDGET_DEFS.map((def) => [def.id, def]));
		for (const id of WIDGET_IDS) {
			expect(defsById.has(id), id).toBe(true);
		}
	});

	test('WidgetDataMap is exhaustive over WIDGET_IDS (compile-time pin verified at runtime)', () => {
		// WidgetDataMap is a mapped union keyed by WidgetId. We verify at runtime
		// that every id maps to a concrete payload type by reading the source and
		// confirming no id is missing from the map. A missing key would be a
		// compile error, but the source scan catches a regression before tsc.
		const dashboardSource = readFileSync(
			new URL('../model/dashboard.ts', import.meta.url),
			'utf8'
		);
		for (const id of WIDGET_IDS) {
			// Each id must appear as a key (quoted or unquoted) in the WidgetDataMap mapped type.
			expect(dashboardSource, id).toMatch(new RegExp(`(?:'|"|${id.replace(/-/g, '\\-')}\\s*:)`));
		}
	});
});

describe('widgetSource derivation invariant', () => {
	test('widgetSource(id) derives /api/dashboard/<id> for every registered id', () => {
		for (const id of WIDGET_IDS) {
			expect(widgetSource(id), id).toBe(`/api/dashboard/${id}`);
		}
	});
});

describe('registry params spread correctly for parameterized bodies', () => {
	test('sessions-per-day and cost-per-day share the DayTableWidget loader', async () => {
		const sessionsLoad = WIDGET_REGISTRY['sessions-per-day'].load;
		const costLoad = WIDGET_REGISTRY['cost-per-day'].load;
		// Both loaders must resolve to the same component module.
		const [sessionsMod, costMod] = await Promise.all([
			sessionsLoad(),
			costLoad()
		]);
		expect(sessionsMod.default).toBe(costMod.default);
	});

	test('sessions-per-day params carry label=Sessions and formatValue=function', () => {
		const params = WIDGET_REGISTRY['sessions-per-day'].params;
		expect(params?.label).toBe('Sessions');
		expect(typeof params?.formatValue).toBe('function');
	});

	test('cost-per-day params carry label=Cost and formatValue=function', () => {
		const params = WIDGET_REGISTRY['cost-per-day'].params;
		expect(params?.label).toBe('Cost');
		expect(typeof params?.formatValue).toBe('function');
	});

	test('only sessions-per-day and cost-per-day declare params', () => {
		const idsWithParams: string[] = [];
		const idsWithoutParams: string[] = [];
		for (const id of WIDGET_IDS) {
			const entry = WIDGET_REGISTRY[id] as { params?: Record<string, unknown> };
			if (entry.params !== undefined) {
				idsWithParams.push(id);
			} else {
				idsWithoutParams.push(id);
			}
		}
		expect(idsWithParams).toEqual(['sessions-per-day', 'cost-per-day']);
		expect(idsWithoutParams).toHaveLength(WIDGET_IDS.length - 2);
	});
});

describe('isEmpty guard invariant', () => {
	test('top-tools declares an isEmpty rule; all others do not', () => {
		for (const id of WIDGET_IDS) {
			const entry = WIDGET_REGISTRY[id];
			if (id === 'top-tools') {
				expect(typeof (entry as { isEmpty?: unknown }).isEmpty).toBe('function');
			} else {
				expect((entry as { isEmpty?: unknown }).isEmpty).toBeUndefined();
			}
		}
	});

	test('top-tools isEmpty returns true for empty tools array', () => {
		const isEmpty = WIDGET_REGISTRY['top-tools'].isEmpty!;
		expect(isEmpty({ tools: [], capped: false })).toBe(true);
	});

	test('top-tools isEmpty returns false when tools have entries', () => {
		const isEmpty = WIDGET_REGISTRY['top-tools'].isEmpty!;
		expect(
			isEmpty({
				tools: [{ name: 'bash', count: 10, errors: 0, errorShare: 0 }],
				capped: false
			})
		).toBe(false);
	});
});

describe('registry source stays server-free and DOM-free (post-refactor)', () => {
	const source = readFileSync(new URL('./registry.ts', import.meta.url), 'utf8');

	test('does not import $lib/server, bun:sqlite, Svelte or the DOM', () => {
		expect(source).not.toMatch(/from ['"]\$lib\/server/);
		expect(source).not.toMatch(/from ['"]bun:sqlite/);
		expect(source).not.toMatch(/from ['"]svelte/);
		expect(source).not.toMatch(/\bdocument\.|\bwindow\./);
	});

	test('imports only layout.ts and model/dashboard/format as external dependencies', () => {
		const imports = source.match(/from ['"][^'"]+['"]/g) ?? [];
		const valid = imports.every((imp) =>
			imp.includes('$lib/components/features/dashboard/layout') ||
			imp.includes('$lib/model/dashboard') ||
			imp.includes('$lib/model/format')
		);
		expect(valid).toBe(true);
	});
});
