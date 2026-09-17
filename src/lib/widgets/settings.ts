/**
 * Pure per-widget settings contract (epic #512, task #515).
 *
 * The registry declares each widget's settings schema; this module turns that
 * schema into the effective values, the cache signature and the `w.<key>=1|0`
 * request params, and parses those params back leniently. Client-safe and
 * side-effect free: it imports `registry.ts` only and never a server module or
 * the DOM, so SSR and the browser share one contract.
 *
 * Everything is driven by `widgetSettingDefs(id)`, so a widget with no declared
 * settings resolves/coerces/serialises to `{}` and never throws.
 */
import { widgetSettingDefs, type WidgetId, type WidgetSettingValues } from './registry';

/** True for a non-null, non-array object (an untrusted settings payload). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge a raw string-keyed record into a widget's effective values: one entry
 * per declared key, using the stored value only when it is exactly a boolean,
 * else the registry default. Unknown keys and non-boolean values are dropped
 * (never coerced). The single merge site every other helper builds on.
 */
function mergeSettingValues(
	id: WidgetId,
	stored: Record<string, unknown> | null
): WidgetSettingValues {
	const values: WidgetSettingValues = {};
	for (const def of widgetSettingDefs(id)) {
		const override = stored?.[def.key];
		values[def.key] = typeof override === 'boolean' ? override : def.default;
	}
	return values;
}

/**
 * Resolve a widget's effective setting values: the registry defaults merged
 * with the known boolean overrides in `stored`. `undefined`/`null` (no stored
 * override) yields the all-defaults map; a widget with no declared settings
 * yields `{}`. Never throws.
 */
export function resolveWidgetSettingValues(
	id: WidgetId,
	stored?: WidgetSettingValues | null
): WidgetSettingValues {
	return mergeSettingValues(id, stored ?? null);
}

/**
 * Coerce an untrusted value (a settings-file leaf or an API payload) into a
 * widget's effective values: non-object input yields the defaults, and unknown
 * keys plus non-boolean values are dropped. Never throws.
 */
export function coerceWidgetSettingValues(id: WidgetId, raw: unknown): WidgetSettingValues {
	return mergeSettingValues(id, isPlainRecord(raw) ? raw : null);
}

/**
 * Canonical signature of a widget's effective settings for cache keying: one
 * `key=1|0` entry per declared key, in declaration order, independent of the
 * object's key insertion order. Any value change changes the signature; a
 * widget with no settings yields `''`.
 */
export function widgetSettingSignature(id: WidgetId, values: WidgetSettingValues): string {
	const resolved = mergeSettingValues(id, values);
	return widgetSettingDefs(id)
		.map((def) => `${def.key}=${resolved[def.key] ? '1' : '0'}`)
		.join('|');
}

/**
 * The `w.<key>=1|0` query params for a widget: every declared key is emitted
 * (resolved values, defaults included) so the client and the server always see
 * one canonical map. A widget with no settings yields `{}`.
 */
export function widgetSettingParams(
	id: WidgetId,
	values: WidgetSettingValues
): Record<string, '1' | '0'> {
	const resolved = mergeSettingValues(id, values);
	const params: Record<string, '1' | '0'> = {};
	for (const def of widgetSettingDefs(id)) {
		params[`w.${def.key}`] = resolved[def.key] ? '1' : '0';
	}
	return params;
}

/**
 * Parse `w.<key>=1|0` query params back into a widget's effective values,
 * leniently: an absent or malformed value falls back to the registry default
 * and unknown `w.*` params are ignored — a stale or hand-edited deep link can
 * never break a widget. A widget with no settings yields `{}`. Never throws.
 */
export function parseWidgetSettingParams(
	id: WidgetId,
	params: URLSearchParams
): WidgetSettingValues {
	const stored: WidgetSettingValues = {};
	for (const def of widgetSettingDefs(id)) {
		const raw = params.get(`w.${def.key}`);
		if (raw === '1') stored[def.key] = true;
		else if (raw === '0') stored[def.key] = false;
	}
	return resolveWidgetSettingValues(id, stored);
}
