/**
 * Dashboard widget registry (dashboard Phase 1, task #402; resizable in #438).
 *
 * The single client-safe source of widget identity, aggregation tier, default
 * placement and default membership, mirroring spec §2.1. Imported by both SSR
 * and client code (and by the settings store for ordering), so it must stay
 * free of `$lib/server` / DB imports and of any DOM/Svelte dependency. Pure and
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
 * Dominant aggregation source tier (spec §2.3): `S` = `session` scan (cheap),
 * `M` = `message` day buckets (medium), `P` = `part` tool frequency (heavy).
 */
export type WidgetTier = 'S' | 'M' | 'P';

/** Width is a count of equal quarter-width grid blocks (4 = full row). */
export const WIDGET_MIN_WIDTH = 1;
export const WIDGET_MAX_WIDTH = 4;
/** Height is a count of 6rem grid rows. */
export const WIDGET_MIN_HEIGHT = 1;
export const WIDGET_MAX_HEIGHT = 8;

/** Clamp a width to the supported block range (non-finite -> minimum). */
export function clampWidth(value: number): number {
	if (!Number.isFinite(value)) return WIDGET_MIN_WIDTH;
	return Math.min(WIDGET_MAX_WIDTH, Math.max(WIDGET_MIN_WIDTH, Math.round(value)));
}

/** Clamp a height to the supported row range (non-finite -> minimum). */
export function clampHeight(value: number): number {
	if (!Number.isFinite(value)) return WIDGET_MIN_HEIGHT;
	return Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, Math.round(value)));
}

/**
 * Clamp a height to this widget's own range: `[def.minHeight, WIDGET_MAX_HEIGHT]`.
 * The per-widget minimum keeps every body legible at the smallest allowed size,
 * so a persisted height below it is raised rather than rendered broken.
 */
export function clampWidgetHeight(id: WidgetId, value: number): number {
	return Math.max(findWidgetDef(id).minHeight, clampHeight(value));
}

/** One persisted/grid placement for a widget: id plus its size. */
export interface WidgetPlacement {
	id: WidgetId;
	/** Width in quarter-width blocks (1–4). */
	width: number;
	/** Height in 6rem rows (1–8). */
	height: number;
}

/** One registrable dashboard widget. */
export interface WidgetDef {
	/** Stable identifier; also the `dashboardWidgets` persistence value. */
	id: WidgetId;
	/** Human-readable card title. */
	title: string;
	/** Registry-default width in quarter-width blocks (1–4). */
	width: number;
	/** Registry-default height in 6rem rows (1–8). */
	height: number;
	/** Smallest height (rows) at which this widget's body stays legible. */
	minHeight: number;
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
 * mix, activity heatmap) are intentionally not registered here (spec §3). The
 * `width`/`height` are the per-widget registry defaults (task #438).
 */
export const WIDGET_DEFS: readonly WidgetDef[] = [
	{
		id: 'kpi',
		title: 'Cost & tokens',
		width: 4,
		height: 2,
		minHeight: 2,
		tier: 'M',
		defaultOn: true,
		source: '/api/dashboard/kpi'
	},
	{
		id: 'sessions-per-day',
		title: 'Sessions per day',
		width: 2,
		height: 3,
		minHeight: 3,
		tier: 'S',
		defaultOn: true,
		source: '/api/dashboard/sessions-per-day'
	},
	{
		id: 'cost-per-day',
		title: 'Cost per day',
		width: 2,
		height: 3,
		minHeight: 3,
		tier: 'M',
		defaultOn: true,
		source: '/api/dashboard/cost-per-day'
	},
	{
		id: 'top-tools',
		title: 'Top tools',
		width: 2,
		height: 3,
		minHeight: 2,
		tier: 'P',
		defaultOn: true,
		source: '/api/dashboard/top-tools'
	},
	{
		id: 'agent-distribution',
		title: 'Agent distribution',
		width: 1,
		height: 3,
		minHeight: 2,
		tier: 'S',
		defaultOn: true,
		source: '/api/dashboard/agent-distribution'
	},
	{
		id: 'top-projects',
		title: 'Top projects',
		width: 2,
		height: 3,
		minHeight: 1,
		tier: 'S',
		defaultOn: true,
		source: '/api/dashboard/top-projects'
	}
];

const WIDGET_DEF_BY_ID: ReadonlyMap<WidgetId, WidgetDef> = new Map(
	WIDGET_DEFS.map((def) => [def.id, def] as const)
);

/** Look up a registry def by id; throws for an id the registry does not define. */
export function findWidgetDef(id: WidgetId): WidgetDef {
	const def = WIDGET_DEF_BY_ID.get(id);
	if (!def) throw new Error(`Unknown widget id: ${id}`);
	return def;
}

/**
 * The first-visit default placements, in registry order. Derived from
 * {@link WIDGET_DEFS} so `defaultOn`/default sizes stay the single source of
 * truth.
 */
export const DEFAULT_WIDGETS: readonly WidgetPlacement[] = WIDGET_DEFS.filter(
	(def) => def.defaultOn
).map((def) => ({ id: def.id, width: def.width, height: def.height }));

/** Every registered id, in registry order. */
export const WIDGET_IDS: readonly WidgetId[] = WIDGET_DEFS.map((def) => def.id);

const WIDGET_ID_SET: ReadonlySet<string> = new Set(WIDGET_IDS);

/** Type guard for untrusted input (settings file, URL, API payloads). */
export function isWidgetId(value: unknown): value is WidgetId {
	return typeof value === 'string' && WIDGET_ID_SET.has(value);
}

/** Parse one raw entry into an id plus optional size overrides; unknown -> null. */
function parsePlacement(entry: unknown): { id: WidgetId; width?: number; height?: number } | null {
	if (typeof entry === 'string') {
		return isWidgetId(entry) ? { id: entry } : null;
	}
	if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
		const record = entry as Record<string, unknown>;
		if (!isWidgetId(record.id)) return null;
		return {
			id: record.id,
			width: typeof record.width === 'number' ? record.width : undefined,
			height: typeof record.height === 'number' ? record.height : undefined
		};
	}
	return null;
}

/**
 * Resolve persisted/raw placements: accepts legacy `string[]` ids and
 * `{id,width,height}` objects, drops unknown ids, collapses duplicates (first
 * occurrence wins) and returns registry order regardless of input order. A
 * missing or non-numeric size falls back to the registry default; numeric sizes
 * are clamped into the bound range (height against the per-widget minimum).
 * Never throws.
 */
export function resolvePlacements(raw: unknown): WidgetPlacement[] {
	if (!Array.isArray(raw)) return [];
	const requested = new Map<WidgetId, { width?: number; height?: number }>();
	for (const entry of raw) {
		const parsed = parsePlacement(entry);
		if (parsed && !requested.has(parsed.id)) {
			requested.set(parsed.id, { width: parsed.width, height: parsed.height });
		}
	}
	return WIDGET_DEFS.filter((def) => requested.has(def.id)).map((def) => {
		const override = requested.get(def.id);
		return {
			id: def.id,
			width: override?.width === undefined ? def.width : clampWidth(override.width),
			height: override?.height === undefined ? def.height : clampWidgetHeight(def.id, override.height)
		};
	});
}
