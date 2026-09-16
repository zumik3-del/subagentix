import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	DEFAULT_WIDGETS,
	isWidgetId,
	resolveWidgets,
	WIDGET_DEFS,
	WIDGET_IDS
} from './registry';
import type { WidgetId, WidgetSize, WidgetTier } from './registry';

/**
 * Unit tests for the dashboard widget registry (dashboard Phase 1, task #402).
 *
 * The registry is the single shared contract for widget identity, order and
 * default membership, and is imported by both SSR and client code. These tests
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
		expect(WIDGET_DEFS.map((def) => def.id)).toEqual([
			'kpi',
			'sessions-per-day',
			'cost-per-day',
			'top-tools',
			'agent-distribution',
			'top-projects'
		]);
	});

	test('every id is unique', () => {
		const ids = WIDGET_DEFS.map((def) => def.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test('every def has a title, a valid size, a valid tier and an endpoint source', () => {
		const sizes: readonly WidgetSize[] = ['1x1', '2x1', 'full'];
		const tiers: readonly WidgetTier[] = ['S', 'M', 'P'];
		for (const def of WIDGET_DEFS) {
			expect(def.title.length, def.id).toBeGreaterThan(0);
			expect(sizes, def.id).toContain(def.size);
			expect(tiers, def.id).toContain(def.tier);
			expect(def.source, def.id).toBe(`/api/dashboard/${def.id}`);
		}
	});

	test('kpi is full-width; the donut is 1x1; the rest are 2x1', () => {
		const byId = new Map(WIDGET_DEFS.map((def) => [def.id, def]));
		expect(byId.get('kpi')?.size).toBe('full');
		expect(byId.get('agent-distribution')?.size).toBe('1x1');
		for (const id of ['sessions-per-day', 'cost-per-day', 'top-tools', 'top-projects'] as const) {
			expect(byId.get(id)?.size, id).toBe('2x1');
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
	test('is the six v1 widgets in registry order', () => {
		expect(DEFAULT_WIDGETS).toEqual(SPEC_IDS);
		expect(DEFAULT_WIDGETS).toEqual(WIDGET_IDS);
	});

	test('contains only ids that the registry defines', () => {
		for (const id of DEFAULT_WIDGETS) {
			expect(isWidgetId(id), id).toBe(true);
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

describe('resolveWidgets()', () => {
	test('returns registry order regardless of input order', () => {
		expect(resolveWidgets(['top-projects', 'kpi', 'cost-per-day']).map((def) => def.id)).toEqual([
			'kpi',
			'cost-per-day',
			'top-projects'
		]);
	});

	test('drops unknown ids and dedupes', () => {
		expect(resolveWidgets(['kpi', 'ghost', 'kpi', 'top-tools', '']).map((def) => def.id)).toEqual([
			'kpi',
			'top-tools'
		]);
	});

	test('empty or all-unknown input yields no widgets (an explicit empty selection)', () => {
		expect(resolveWidgets([])).toEqual([]);
		expect(resolveWidgets(['ghost', 'nope'])).toEqual([]);
	});

	test('returns the full registry for every registered id', () => {
		expect(resolveWidgets([...WIDGET_IDS].reverse()).map((def) => def.id)).toEqual([...WIDGET_IDS]);
	});

	test('does not mutate the input array', () => {
		const input = ['top-tools', 'kpi'];
		resolveWidgets(input);
		expect(input).toEqual(['top-tools', 'kpi']);
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
