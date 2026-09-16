/**
 * Dashboard widget registry (dashboard Phase 1, task #402).
 *
 * The single client-safe source of widget identity, size, aggregation tier and
 * default membership, mirroring spec §2.1. Imported by both SSR and client code
 * (and by the settings store for ordering), so it must stay free of
 * `$lib/server` / DB imports and of any DOM/Svelte dependency. Pure and
 * deterministic; no I/O.
 */

/** The v1 dashboard widgets. Registry order is picker order. */
export type WidgetId =
	| 'kpi'
	| 'sessions-per-day'
	| 'cost-per-day'
	| 'top-tools'
	| 'agent-distribution'
	| 'top-projects';

/**
 * Fixed grid footprint (spec §2.7): `1x1` = 4 of 12 columns, `2x1` = 8,
 * `full` = the whole row. No drag-and-drop in v1.
 */
export type WidgetSize = '1x1' | '2x1' | 'full';

/**
 * Dominant aggregation source tier (spec §2.3): `S` = `session` scan (cheap),
 * `M` = `message` day buckets (medium), `P` = `part` tool frequency (heavy).
 */
export type WidgetTier = 'S' | 'M' | 'P';

/** One registrable dashboard widget. */
export interface WidgetDef {
	/** Stable identifier; also the `dashboardWidgets` persistence value. */
	id: WidgetId;
	/** Human-readable card title. */
	title: string;
	/** Grid footprint. */
	size: WidgetSize;
	/** Dominant aggregation source tier (`S` | `M` | `P`). */
	tier: WidgetTier;
	/** `true` when the widget is part of the first-visit default selection. */
	defaultOn: boolean;
	/** Widget data endpoint: `/api/dashboard/<id>`. */
	source: string;
}

/**
 * Every v1 widget, in registry (picker) order. `defaultOn` is `true` for the
 * six first-visit defaults; optional catalog extensions (top models, token
 * mix, activity heatmap) are intentionally not registered here (spec §3).
 */
export const WIDGET_DEFS: readonly WidgetDef[] = [
	{
		id: 'kpi',
		title: 'Cost & tokens',
		size: 'full',
		tier: 'M',
		defaultOn: true,
		source: '/api/dashboard/kpi'
	},
	{
		id: 'sessions-per-day',
		title: 'Sessions per day',
		size: '2x1',
		tier: 'S',
		defaultOn: true,
		source: '/api/dashboard/sessions-per-day'
	},
	{
		id: 'cost-per-day',
		title: 'Cost per day',
		size: '2x1',
		tier: 'M',
		defaultOn: true,
		source: '/api/dashboard/cost-per-day'
	},
	{
		id: 'top-tools',
		title: 'Top tools',
		size: '2x1',
		tier: 'P',
		defaultOn: true,
		source: '/api/dashboard/top-tools'
	},
	{
		id: 'agent-distribution',
		title: 'Agent distribution',
		size: '1x1',
		tier: 'S',
		defaultOn: true,
		source: '/api/dashboard/agent-distribution'
	},
	{
		id: 'top-projects',
		title: 'Top projects',
		size: '2x1',
		tier: 'S',
		defaultOn: true,
		source: '/api/dashboard/top-projects'
	}
];

/**
 * The first-visit default selection, in registry order. Derived from
 * {@link WIDGET_DEFS} so `defaultOn` stays the single source of truth.
 */
export const DEFAULT_WIDGETS: readonly WidgetId[] = WIDGET_DEFS.filter(
	(def) => def.defaultOn
).map((def) => def.id);

/** Every registered id, in registry order. */
export const WIDGET_IDS: readonly WidgetId[] = WIDGET_DEFS.map((def) => def.id);

const WIDGET_ID_SET: ReadonlySet<string> = new Set(WIDGET_IDS);

/** Type guard for untrusted input (settings file, URL, API payloads). */
export function isWidgetId(value: unknown): value is WidgetId {
	return typeof value === 'string' && WIDGET_ID_SET.has(value);
}

/**
 * Resolve persisted/raw ids into defs: drop unknown ids, dedupe, and return
 * registry order regardless of input order. Never throws.
 */
export function resolveWidgets(ids: readonly string[]): WidgetDef[] {
	const requested = new Set<string>();
	for (const id of ids) {
		if (isWidgetId(id)) requested.add(id);
	}
	return WIDGET_DEFS.filter((def) => requested.has(def.id));
}
