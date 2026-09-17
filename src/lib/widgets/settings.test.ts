import { describe, expect, test } from 'bun:test';
import {
	coerceWidgetSettingValues,
	parseWidgetSettingParams,
	resolveWidgetSettingValues,
	widgetSettingParams,
	widgetSettingSignature
} from './settings';
import { WIDGET_IDS, widgetSettingDefs } from './registry';

/**
 * Unit tests for the pure per-widget settings contract (epic #512, task #515).
 *
 * No DB, no server imports: drives entirely off `widgetSettingDefs(id)`.
 */

// Only `top-tools` declares settings in the current registry.
const SETTINGS_WIDGET = 'top-tools';
const OTHER_WIDGETS = WIDGET_IDS.filter((id) => id !== SETTINGS_WIDGET);

describe('resolveWidgetSettingValues()', () => {
	test('returns registry defaults when nothing is stored', () => {
		const values = resolveWidgetSettingValues(SETTINGS_WIDGET);
		const defs = widgetSettingDefs(SETTINGS_WIDGET);
		for (const def of defs) {
			expect(values[def.key]).toBe(def.default);
		}
	});

	test('returns {} for a widget with no declared settings', () => {
		for (const id of OTHER_WIDGETS) {
			expect(resolveWidgetSettingValues(id)).toEqual({});
		}
	});

	test('stored override wins over default', () => {
		const values = resolveWidgetSettingValues(SETTINGS_WIDGET, { basic: false, mcp: true });
		expect(values.basic).toBe(false);
		expect(values.mcp).toBe(true);
	});

	test('non-boolean stored values fall back to default', () => {
		const values = resolveWidgetSettingValues(SETTINGS_WIDGET, {
			basic: 'yes' as unknown as boolean,
			mcp: 1 as unknown as boolean
		});
		const defs = widgetSettingDefs(SETTINGS_WIDGET);
		expect(values.basic).toBe(defs.find((d) => d.key === 'basic')!.default);
		expect(values.mcp).toBe(defs.find((d) => d.key === 'mcp')!.default);
	});

	test('unknown keys in stored are dropped', () => {
		const values = resolveWidgetSettingValues(SETTINGS_WIDGET, {
			basic: true,
			exoticKey: false as unknown as boolean
		});
		expect(values).toHaveProperty('basic', true);
		expect(values).not.toHaveProperty('exoticKey');
	});

	test('null stored yields defaults (same as undefined)', () => {
		const withNull = resolveWidgetSettingValues(SETTINGS_WIDGET, null);
		const without = resolveWidgetSettingValues(SETTINGS_WIDGET);
		expect(withNull).toEqual(without);
	});
});

describe('coerceWidgetSettingValues()', () => {
	test('non-object input yields defaults', () => {
		for (const raw of [null, 'yes', 42, true, [], undefined] as unknown[]) {
			const values = coerceWidgetSettingValues(SETTINGS_WIDGET, raw);
			const defs = widgetSettingDefs(SETTINGS_WIDGET);
			for (const def of defs) {
				expect(values[def.key]).toBe(def.default);
			}
		}
	});

	test('unknown keys are dropped (never coerced)', () => {
		const values = coerceWidgetSettingValues(SETTINGS_WIDGET, {
			basic: true,
			exoticKey: 'ignored'
		});
		expect(values).toHaveProperty('basic', true);
		expect(values).not.toHaveProperty('exoticKey');
	});

	test('non-boolean values are dropped in favor of defaults', () => {
		const values = coerceWidgetSettingValues(SETTINGS_WIDGET, {
			basic: 't' as unknown as boolean,
			mcp: 0 as unknown as boolean
		});
		const defs = widgetSettingDefs(SETTINGS_WIDGET);
		expect(values.basic).toBe(defs.find((d) => d.key === 'basic')!.default);
		expect(values.mcp).toBe(defs.find((d) => d.key === 'mcp')!.default);
	});

	test('returns {} for a widget with no declared settings', () => {
		for (const id of OTHER_WIDGETS) {
			expect(coerceWidgetSettingValues(id, { basic: true })).toEqual({});
		}
	});
});

describe('widgetSettingSignature()', () => {
	test('reflects registry defaults when nothing stored', () => {
		const sig = widgetSettingSignature(SETTINGS_WIDGET, {});
		const defs = widgetSettingDefs(SETTINGS_WIDGET);
		const expected = defs
			.map((def) => `${def.key}=${def.default ? '1' : '0'}`)
			.join('|');
		expect(sig).toBe(expected);
	});

	test('changes on any value change', () => {
		const base = widgetSettingSignature(SETTINGS_WIDGET, {});
		const withBasicFalse = widgetSettingSignature(SETTINGS_WIDGET, { basic: false });
		const withMcpFalse = widgetSettingSignature(SETTINGS_WIDGET, { mcp: false });
		// Each changed key must produce a different signature.
		expect(withBasicFalse).not.toBe(base);
		expect(withMcpFalse).not.toBe(base);
		expect(withBasicFalse).not.toBe(withMcpFalse);
	});

	test('independent of key insertion order', () => {
		const a = widgetSettingSignature(SETTINGS_WIDGET, { basic: true, mcp: false });
		const b = widgetSettingSignature(SETTINGS_WIDGET, { mcp: false, basic: true });
		expect(a).toBe(b);
	});

	test('returns empty string for a widget with no settings', () => {
		for (const id of OTHER_WIDGETS) {
			expect(widgetSettingSignature(id, {})).toBe('');
			expect(widgetSettingSignature(id, { anything: true })).toBe('');
		}
	});
});

describe('widgetSettingParams()', () => {
	test('emits w.<key>=1|0 for every declared key', () => {
		const params = widgetSettingParams(SETTINGS_WIDGET, { basic: true, mcp: false });
		expect(params['w.basic']).toBe('1');
		expect(params['w.mcp']).toBe('0');
		expect(Object.keys(params)).toHaveLength(2);
	});

	test('returns {} for a widget with no declared settings', () => {
		for (const id of OTHER_WIDGETS) {
			expect(widgetSettingParams(id, {})).toEqual({});
		}
	});

	test('defaults are included in the emitted params', () => {
		const params = widgetSettingParams(SETTINGS_WIDGET, {});
		const defs = widgetSettingDefs(SETTINGS_WIDGET);
		for (const def of defs) {
			const expected = def.default ? '1' : '0';
			expect(params[`w.${def.key}`]).toBe(expected);
		}
	});
});

describe('parseWidgetSettingParams()', () => {
	test('parses valid w.<key>=1|0 params', () => {
		const params = new URLSearchParams('w.basic=1&w.mcp=0');
		const values = parseWidgetSettingParams(SETTINGS_WIDGET, params);
		expect(values.basic).toBe(true);
		expect(values.mcp).toBe(false);
	});

	test('missing params fall back to defaults', () => {
		const params = new URLSearchParams();
		const values = parseWidgetSettingParams(SETTINGS_WIDGET, params);
		const defs = widgetSettingDefs(SETTINGS_WIDGET);
		for (const def of defs) {
			expect(values[def.key]).toBe(def.default);
		}
	});

	test('malformed value (not 0 or 1) falls back to default', () => {
		const params = new URLSearchParams('w.basic=2&w.mcp=true&w.exotic=abc');
		const values = parseWidgetSettingParams(SETTINGS_WIDGET, params);
		const defs = widgetSettingDefs(SETTINGS_WIDGET);
		for (const def of defs) {
			expect(values[def.key]).toBe(def.default);
		}
	});

	test('unknown w.* params are ignored', () => {
		const params = new URLSearchParams('w.basic=1&w.unknown=1&w.exotic=0');
		const values = parseWidgetSettingParams(SETTINGS_WIDGET, params);
		expect(values.basic).toBe(true);
		expect(values).not.toHaveProperty('unknown');
		expect(values).not.toHaveProperty('exotic');
		// mcp should still be default.
		expect(values.mcp).toBe(widgetSettingDefs(SETTINGS_WIDGET).find((d) => d.key === 'mcp')!.default);
	});

	test('round-trips params -> values -> params', () => {
		const original = new URLSearchParams('w.basic=0&w.mcp=1');
		const values = parseWidgetSettingParams(SETTINGS_WIDGET, original);
		const rebuilt = widgetSettingParams(SETTINGS_WIDGET, values);
		const rebuiltParams = new URLSearchParams(
			Object.entries(rebuilt) as [string, string][]
		);
		expect(rebuiltParams.toString()).toBe(original.toString());
	});

	test('returns {} for a widget with no declared settings', () => {
		for (const id of OTHER_WIDGETS) {
			const params = new URLSearchParams('w.any=1');
			expect(parseWidgetSettingParams(id, params)).toEqual({});
		}
	});
});
