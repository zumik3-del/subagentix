import { describe, expect, test } from 'bun:test';
import { toggleWidgetSelection, samePlacements, updatePlacement } from './picker';
import { WIDGET_IDS, type WidgetId, type WidgetPlacement } from '$lib/widgets/registry';

/**
 * Unit tests for the pure dashboard widget-picker selection logic
 * (dashboard Phase 5, task #414; resizable in #438).
 *
 * Kept in a plain `.ts` module so the toggle/compare/size rules are testable
 * without a renderer or a DOM (docs/ui-standards.md §10).
 */

describe('toggleWidgetSelection()', () => {
	test('adds a widget placement to an empty selection', () => {
		const next = toggleWidgetSelection([], 'kpi');
		expect(next).toEqual([{ id: 'kpi', width: 4, height: 2 }]);
	});

	test('removes a widget placement that is already selected', () => {
		const next = toggleWidgetSelection([{ id: 'kpi', width: 4, height: 2 }], 'kpi');
		expect(next).toEqual([]);
	});

	test('toggles a widget placement in a multi-selection', () => {
		const next = toggleWidgetSelection(
			[{ id: 'kpi', width: 4, height: 2 }, { id: 'top-tools', width: 2, height: 3 }],
			'kpi'
		);
		expect(next).toEqual([{ id: 'top-tools', width: 2, height: 3 }]);
	});

	test('returns placements in registry order, not input order', () => {
		const next = toggleWidgetSelection(
			[{ id: 'top-tools', width: 2, height: 3 }, { id: 'kpi', width: 4, height: 2 }],
			'sessions-per-day'
		);
		// kpi comes before sessions-per-day in registry order.
		expect(next.map((p) => p.id)).toEqual(['kpi', 'sessions-per-day', 'top-tools']);
	});

	test('does not mutate the input array', () => {
		const input: readonly WidgetPlacement[] = [
			{ id: 'kpi', width: 4, height: 2 },
			{ id: 'top-tools', width: 2, height: 3 }
		];
		toggleWidgetSelection(input, 'sessions-per-day');
		expect(input).toEqual([
			{ id: 'kpi', width: 4, height: 2 },
			{ id: 'top-tools', width: 2, height: 3 }
		]);
	});

	test('adding a known id restores the registry-default size', () => {
		const before: WidgetPlacement[] = [{ id: 'top-tools', width: 3, height: 5 }];
		const next = toggleWidgetSelection(before, 'kpi');
		// kpi should get its registry default, not a stale size.
		expect(next.find((p) => p.id === 'kpi')).toEqual({ id: 'kpi', width: 4, height: 2 });
		// Existing custom size is preserved.
		expect(next.find((p) => p.id === 'top-tools')).toEqual({ id: 'top-tools', width: 3, height: 5 });
	});

	test('toggling off then on restores the registry default size', () => {
		const withCustom: WidgetPlacement[] = [{ id: 'kpi', width: 1, height: 1 }];
		const toggledOff = toggleWidgetSelection(withCustom, 'kpi');
		expect(toggledOff).toEqual([]);
		const toggledOn = toggleWidgetSelection(toggledOff, 'kpi');
		expect(toggledOn).toEqual([{ id: 'kpi', width: 4, height: 2 }]);
	});

	test('unknown ids are dropped (not added)', () => {
		const next = toggleWidgetSelection([], 'top-model' as WidgetId);
		expect(next).toEqual([]);
	});
});

describe('samePlacements()', () => {
	test('two identical placements are equal', () => {
		const a: WidgetPlacement[] = [
			{ id: 'kpi', width: 4, height: 2 },
			{ id: 'top-tools', width: 2, height: 3 }
		];
		expect(samePlacements(a, a)).toBe(true);
	});

	test('different lengths are not equal', () => {
		const a: WidgetPlacement[] = [{ id: 'kpi', width: 4, height: 2 }];
		const b: WidgetPlacement[] = [
			{ id: 'kpi', width: 4, height: 2 },
			{ id: 'top-tools', width: 2, height: 3 }
		];
		expect(samePlacements(a, b)).toBe(false);
	});

	test('same ids in different order are equal', () => {
		const a: WidgetPlacement[] = [
			{ id: 'top-tools', width: 2, height: 3 },
			{ id: 'kpi', width: 4, height: 2 }
		];
		const b: WidgetPlacement[] = [
			{ id: 'kpi', width: 4, height: 2 },
			{ id: 'top-tools', width: 2, height: 3 }
		];
		expect(samePlacements(a, b)).toBe(true);
	});

	test('empty placements are equal', () => {
		expect(samePlacements([], [])).toBe(true);
	});

	test('all registry ids pairwise compared with themselves are equal', () => {
		const all: WidgetPlacement[] = WIDGET_IDS.map((id) => ({ id, width: 4, height: 8 }));
		expect(samePlacements(all, all)).toBe(true);
	});

	test('a single missing id makes them not equal', () => {
		const a: WidgetPlacement[] = WIDGET_IDS.map((id) => ({ id, width: 1, height: 1 }));
		const b: WidgetPlacement[] = [...a, { id: 'top-projects' as WidgetId, width: 1, height: 1 }];
		expect(samePlacements(a, b)).toBe(false);
	});

	test('size-only change is NOT equal (drives modal dirty state)', () => {
		const a: WidgetPlacement[] = [{ id: 'kpi', width: 4, height: 2 }];
		const b: WidgetPlacement[] = [{ id: 'kpi', width: 2, height: 2 }];
		expect(samePlacements(a, b)).toBe(false);
	});

	test('no-op placement list is equal', () => {
		const a: WidgetPlacement[] = [{ id: 'kpi', width: 4, height: 2 }];
		expect(samePlacements(a, a)).toBe(true);
	});
});

describe('updatePlacement()', () => {
	test('patches width while preserving other fields', () => {
		const input: WidgetPlacement[] = [{ id: 'kpi', width: 4, height: 2 }];
		const next = updatePlacement(input, 'kpi', { width: 2 });
		expect(next).toEqual([{ id: 'kpi', width: 2, height: 2 }]);
	});

	test('patches height while preserving other fields', () => {
		const input: WidgetPlacement[] = [{ id: 'kpi', width: 4, height: 2 }];
		const next = updatePlacement(input, 'kpi', { height: 5 });
		expect(next).toEqual([{ id: 'kpi', width: 4, height: 5 }]);
	});

	test('patches both width and height', () => {
		const input: WidgetPlacement[] = [{ id: 'kpi', width: 4, height: 2 }];
		const next = updatePlacement(input, 'kpi', { width: 3, height: 6 });
		expect(next).toEqual([{ id: 'kpi', width: 3, height: 6 }]);
	});

	test('does not mutate the input array', () => {
		const input: readonly WidgetPlacement[] = [{ id: 'kpi', width: 4, height: 2 }];
		updatePlacement(input, 'kpi', { width: 2 });
		expect(input).toEqual([{ id: 'kpi', width: 4, height: 2 }]);
	});

	test('keeps registry order', () => {
		const input: WidgetPlacement[] = [
			{ id: 'top-tools', width: 2, height: 3 },
			{ id: 'kpi', width: 4, height: 2 }
		];
		const next = updatePlacement(input, 'top-tools', { width: 3 });
		expect(next.map((p) => p.id)).toEqual(['kpi', 'top-tools']);
	});
});

/**
 * Verify picker.ts stays DOM-free and server-free.
 */
describe('picker.ts stays DOM-free and server-free', () => {
	test('does not import $lib/server, Svelte or the DOM', async () => {
		const source = new URL('./picker.ts', import.meta.url);
		const content = await Bun.file(source).text();
		expect(content).not.toMatch(/from ['"]\$lib\/server/);
		expect(content).not.toMatch(/from ['"]svelte/);
		expect(content).not.toMatch(/\bdocument\.|\bwindow\./);
	});
});
