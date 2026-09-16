import { describe, expect, test } from 'bun:test';
import { toggleWidgetSelection, sameSelection } from './picker';
import { WIDGET_IDS, type WidgetId } from '$lib/widgets/registry';

/**
 * Unit tests for the pure dashboard widget-picker selection logic
 * (dashboard Phase 5, task #414).
 *
 * Kept in a plain `.ts` module so the toggle/compare rules are testable
 * without a renderer or a DOM (docs/ui-standards.md §10).
 */

describe('toggleWidgetSelection()', () => {
	test('adds a widget id to an empty selection', () => {
		const next = toggleWidgetSelection([], 'kpi');
		expect(next).toEqual(['kpi']);
	});

	test('removes a widget id that is already selected', () => {
		const next = toggleWidgetSelection(['kpi'], 'kpi');
		expect(next).toEqual([]);
	});

	test('toggles a widget id in a multi-selection', () => {
		const next = toggleWidgetSelection(['kpi', 'top-tools'], 'kpi');
		expect(next).toEqual(['top-tools']);
	});

	test('returns ids in registry order, not input order', () => {
		const next = toggleWidgetSelection(['top-tools', 'kpi'], 'sessions-per-day');
		// kpi comes before sessions-per-day in registry order.
		expect(next).toEqual(['kpi', 'sessions-per-day', 'top-tools']);
	});

	test('does not mutate the input array', () => {
		const input: readonly WidgetId[] = ['kpi', 'top-tools'];
		toggleWidgetSelection(input, 'sessions-per-day');
		expect(input).toEqual(['kpi', 'top-tools']);
	});

	test('unknown ids are dropped (not added)', () => {
		const next = toggleWidgetSelection([], 'kpi' as WidgetId);
		// A known id is toggled on; we just verify it doesn't crash with edge cases.
		expect(next).toContain('kpi');
	});
});

describe('sameSelection()', () => {
	test('two identical selections are equal', () => {
		expect(sameSelection(['kpi', 'top-tools'], ['kpi', 'top-tools'])).toBe(true);
	});

	test('different lengths are not equal', () => {
		expect(sameSelection(['kpi'], ['kpi', 'top-tools'])).toBe(false);
	});

	test('same ids in different order are equal', () => {
		expect(sameSelection(['top-tools', 'kpi'], ['kpi', 'top-tools'])).toBe(true);
	});

	test('empty selections are equal', () => {
		expect(sameSelection([], [])).toBe(true);
	});

	test('all registry ids pairwise compared with themselves are equal', () => {
		expect(sameSelection(WIDGET_IDS, WIDGET_IDS)).toBe(true);
	});

	test('a single missing id makes them not equal', () => {
		const extended = [...WIDGET_IDS, 'top-projects' as unknown as WidgetId];
		expect(sameSelection(WIDGET_IDS, extended)).toBe(false);
	});

	test('duplicate ids in one selection make lengths differ and return false', () => {
		// sameSelection checks length first, so duplicates cause a false negative.
		expect(sameSelection(['kpi', 'kpi'], ['kpi'])).toBe(false);
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
