/**
 * Dashboard widget registry (dashboard Phase 1, task #402; resizable in #438;
 * single descriptor registry in #489).
 *
 * The single client-safe source of widget identity, aggregation tier, default
 * placement, default membership and body loader, mirroring spec §2.1. Imported
 * by both SSR and client code (and by the settings store for ordering), so it
 * must stay free of `$lib/server` / DB imports and of any DOM/Svelte runtime
 * import. Pure and deterministic; no I/O. Each per-widget `load` is a Vite
 * dynamic `import()` — the code-split boundary is evaluated only when a body is
 * mounted, so no widget module enters the SSR graph or the initial bundle.
 *
 * Geometry (column count, row/gap px, size bounds) comes from the pure
 * `layout.ts` module so the model, the CSS fallback and the gridstack config
 * share one source; the bounds are re-exported here for existing consumers.
 */
import {
	GRID_COLUMNS,
	WIDGET_MAX_HEIGHT,
	WIDGET_MAX_WIDTH,
	WIDGET_MIN_HEIGHT,
	WIDGET_MIN_WIDTH
} from '$lib/components/features/dashboard/layout';
import { type ToolUsage, type WidgetDataMap } from '$lib/model/dashboard';
import { formatCost, formatNumber } from '$lib/model/format';

/**
 * Size bounds re-exported from `layout.ts` (the shared geometry source): width
 * counts sixth-width blocks (6 = full row), height counts 3rem rows. Kept as
 * named exports so existing importers are unaffected by the move.
 */
export { WIDGET_MAX_HEIGHT, WIDGET_MAX_WIDTH, WIDGET_MIN_HEIGHT, WIDGET_MIN_WIDTH };

/**
 * Dominant aggregation source tier (spec §2.3): `S` = `session` scan (cheap),
 * `M` = `message` day buckets (medium), `P` = `part` tool frequency (heavy).
 * Metadata only: the descriptor does not use it to dispatch a payload.
 */
export type WidgetTier = 'S' | 'M' | 'P';

/**
 * The v1 widget catalog: one descriptor per widget, keyed by its stable id (the
 * `dashboardWidgets` persistence value). Declaration order is registry order
 * (also picker order). Each descriptor carries its card metadata, an optional
 * payload-emptiness rule (`isEmpty`), an optional `params` record of extra
 * props for a shared parameterized body (task #491) and a co-located lazy
 * `load` — the Vite code-split boundary for that widget's body.
 *
 * Every v1 body is a pure `{ data }` renderer wrapped by `WidgetShell`
 * (task #490/#491), so a descriptor carries no chrome or fetch config; the
 * shell owns both.
 */
export const WIDGET_REGISTRY = {
	kpi: {
		title: 'Cost & tokens',
		width: 6,
		height: 4,
		minHeight: 4,
		tier: 'M',
		load: () => import('$lib/components/features/dashboard/KpiWidget.svelte')
	},
	'sessions-per-day': {
		title: 'Sessions per day',
		width: 3,
		height: 6,
		minHeight: 6,
		tier: 'S',
		/**
		 * Shared body: `DayTableWidget` is parameterized by `label`/`formatValue`
		 * only, so this day table and `cost-per-day` register the same component
		 * with different params (task #491).
		 */
		params: { label: 'Sessions', formatValue: formatNumber },
		load: () => import('$lib/components/features/dashboard/DayTableWidget.svelte')
	},
	'cost-per-day': {
		title: 'Cost per day',
		width: 3,
		height: 6,
		minHeight: 6,
		tier: 'M',
		/** Same shared body as `sessions-per-day`; only the params differ. */
		params: { label: 'Cost', formatValue: formatCost },
		load: () => import('$lib/components/features/dashboard/DayTableWidget.svelte')
	},
	'top-tools': {
		title: 'Top tools',
		width: 3,
		height: 6,
		minHeight: 4,
		tier: 'P',
		/** A capped top-tools payload with no rows is empty. */
		isEmpty: (data: ToolUsage) => data.tools.length === 0,
		load: () => import('$lib/components/features/dashboard/TopToolsWidget.svelte')
	},
	'agent-distribution': {
		title: 'Agent distribution',
		width: 2,
		height: 6,
		minHeight: 4,
		tier: 'S',
		load: () => import('$lib/components/features/dashboard/AgentDistributionWidget.svelte')
	},
	'top-projects': {
		title: 'Top projects',
		width: 3,
		height: 6,
		minHeight: 2,
		tier: 'S',
		load: () => import('$lib/components/features/dashboard/TopProjectsWidget.svelte')
	}
} as const;

/**
 * The closed set of widget ids, derived from the registry keys. Adding a widget
 * is adding one descriptor: the union (and every `WidgetDataMap` payload entry)
 * follows from it.
 */
export type WidgetId = keyof typeof WIDGET_REGISTRY;

/**
 * One registered widget: its descriptor plus the registry key it lives under.
 * A mapped union, so each id keeps its own literal type (`id: 'kpi'`, ...).
 */
export type WidgetDef = {
	[K in WidgetId]: { id: K } & (typeof WIDGET_REGISTRY)[K];
}[WidgetId];

/** The `WidgetDef` member for one id; narrows `isEmpty` to that widget's payload. */
export type WidgetDefFor<K extends WidgetId> = Extract<WidgetDef, { id: K }>;

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

/**
 * One persisted/grid placement for a widget: id, size and (for the free-form
 * desktop layout, epic #462) an optional grid position.
 *
 * `x`/`y` are 0-based column/row indices. Like the sizes they are an optional
 * override: a placement without a usable pair is auto-positioned by
 * {@link resolvePlacements}, while an explicit pair is honoured (clamped) so a
 * legacy `{id,width,height}` entry stays valid and just gets a slot.
 */
export interface WidgetPlacement {
	id: WidgetId;
	/** Width in sixth-width blocks (1–6). */
	width: number;
	/** Height in 3rem rows (1–16). */
	height: number;
	/** Optional 0-based column index; both `x` and `y` must be present to take effect. */
	x?: number;
	/** Optional 0-based row index; both `x` and `y` must be present to take effect. */
	y?: number;
}

/**
 * Every v1 widget descriptor, in registry (picker) order. Optional catalog
 * extensions (top models, token mix, activity heatmap) are intentionally not
 * registered here (spec §3). The `width`/`height` are the per-widget registry
 * defaults (task #438); the first-visit arrangement is {@link DEFAULT_WIDGETS}.
 */
export const WIDGET_DEFS: readonly WidgetDef[] = (Object.keys(WIDGET_REGISTRY) as WidgetId[]).map(
	(id) => ({ id, ...WIDGET_REGISTRY[id] }) as WidgetDef
);

const WIDGET_DEF_BY_ID: ReadonlyMap<WidgetId, WidgetDef> = new Map(
	WIDGET_DEFS.map((def) => [def.id, def] as const)
);

/**
 * Look up a registry def by id; throws for an id the registry does not define.
 * The return type narrows to the matching descriptor, so a literal id exposes
 * that widget's `isEmpty` payload type.
 */
export function findWidgetDef<K extends WidgetId>(id: K): WidgetDefFor<K> {
	const def = WIDGET_DEF_BY_ID.get(id);
	if (!def) throw new Error(`Unknown widget id: ${id}`);
	return def as WidgetDefFor<K>;
}

/**
 * The descriptor's optional emptiness rule, narrowed to one widget id
 * (`undefined` = the data hook's default: null/undefined/empty array).
 *
 * `isEmpty` is optional, so the `WidgetDef` union hides it behind a variant; a
 * generic `WidgetShell<K>` needs it keyed by the same id as its payload type.
 * By construction the entry for `id` holds the rule its payload expects, so the
 * accessor can safely expose it as `WidgetDataMap[K]`.
 */
export function widgetIsEmpty<K extends WidgetId>(
	id: K
): ((data: WidgetDataMap[K]) => boolean) | undefined {
	return (
		WIDGET_REGISTRY[id] as unknown as {
			isEmpty?: (data: WidgetDataMap[K]) => boolean;
		}
	).isEmpty;
}

/**
 * The descriptor's optional extra props for a shared parameterized body, as a
 * plain record (`{}` when the widget declares none). `params` is optional, so
 * the `WidgetDef` union hides it behind a variant; a generic `WidgetShell<K>`
 * cannot read it directly. The shared bodies (e.g. `DayTableWidget`) declare
 * their own typed props and receive these through the shell's spread — this is
 * regular component props, not a view schema.
 */
export function widgetParams<K extends WidgetId>(id: K): Record<string, unknown> {
	return (WIDGET_REGISTRY[id] as unknown as { params?: Record<string, unknown> }).params ?? {};
}

/** Every registered id, in registry order. */
export const WIDGET_IDS: readonly WidgetId[] = WIDGET_DEFS.map((def) => def.id);

const WIDGET_ID_SET: ReadonlySet<string> = new Set(WIDGET_IDS);

/** Type guard for untrusted input (settings file, URL, API payloads). */
export function isWidgetId(value: unknown): value is WidgetId {
	return typeof value === 'string' && WIDGET_ID_SET.has(value);
}

/**
 * The widget's data endpoint, derived from its id (spec §2.1). The endpoint
 * format lives here once instead of being stored on every descriptor; the
 * server route is `/api/dashboard/[widget]`.
 */
export function widgetSource(id: WidgetId): string {
	return `/api/dashboard/${id}`;
}

/**
 * The first-visit default placements, in registry order: the hand-arranged
 * starter layout a fresh install renders before any settings are saved (the
 * explicit sizes and grid positions mirror the production dashboard every
 * widget was tuned to). Fed through {@link resolvePlacements} so the entries
 * are clamped, deduped and validated against the grid exactly like a persisted
 * placement, and the output stays registry order.
 */
export const DEFAULT_WIDGETS: readonly WidgetPlacement[] = resolvePlacements([
	{ id: 'kpi', width: 4, height: 6, x: 0, y: 0 },
	{ id: 'sessions-per-day', width: 1, height: 7, x: 5, y: 8 },
	{ id: 'cost-per-day', width: 1, height: 7, x: 4, y: 8 },
	{ id: 'top-tools', width: 2, height: 9, x: 0, y: 6 },
	{ id: 'agent-distribution', width: 2, height: 8, x: 4, y: 0 },
	{ id: 'top-projects', width: 2, height: 9, x: 2, y: 6 }
]);

/** Parse one raw entry into an id plus optional size/position overrides; unknown -> null. */
function parsePlacement(
	entry: unknown
): { id: WidgetId; width?: number; height?: number; x?: number; y?: number } | null {
	if (typeof entry === 'string') {
		return isWidgetId(entry) ? { id: entry } : null;
	}
	if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
		const record = entry as Record<string, unknown>;
		if (!isWidgetId(record.id)) return null;
		return {
			id: record.id,
			width: typeof record.width === 'number' ? record.width : undefined,
			height: typeof record.height === 'number' ? record.height : undefined,
			x: typeof record.x === 'number' ? record.x : undefined,
			y: typeof record.y === 'number' ? record.y : undefined
		};
	}
	return null;
}

/** Clamp an explicit column index so `x + width` stays inside the grid. */
function clampPositionX(value: number, width: number): number {
	return Math.min(GRID_COLUMNS - width, Math.max(0, Math.round(value)));
}

/** Clamp an explicit row index to the grid (rows only grow downward). */
function clampPositionY(value: number): number {
	return Math.max(0, Math.round(value));
}

/**
 * Clamp an explicit `{x,y}` pair into the grid, or `null` when either value is
 * missing/non-finite (a partial pair is treated as unpositioned, never guessed).
 */
function resolveExplicitPosition(
	override: { x?: number; y?: number } | undefined,
	width: number
): { x: number; y: number } | null {
	if (
		override?.x === undefined ||
		override?.y === undefined ||
		!Number.isFinite(override.x) ||
		!Number.isFinite(override.y)
	) {
		return null;
	}
	return { x: clampPositionX(override.x, width), y: clampPositionY(override.y) };
}

/** Cell key for the flat occupancy set. */
function cellKey(x: number, y: number): number {
	return y * GRID_COLUMNS + x;
}

/** Mark every cell of a rectangle as occupied. */
function occupy(occupied: Set<number>, x: number, y: number, width: number, height: number): void {
	for (let cy = y; cy < y + height; cy++) {
		for (let cx = x; cx < x + width; cx++) {
			occupied.add(cellKey(cx, cy));
		}
	}
}

/**
 * First free slot in row-major order whose `width × height` rectangle is fully
 * unoccupied. `width` never exceeds {@link GRID_COLUMNS}, so the scan always
 * finds a slot (below the last occupied row every cell is free) and terminates.
 */
function firstFreeSlot(
	occupied: ReadonlySet<number>,
	width: number,
	height: number
): { x: number; y: number } {
	for (let y = 0; ; y++) {
		for (let x = 0; x + width <= GRID_COLUMNS; x++) {
			let free = true;
			for (let cy = y; cy < y + height && free; cy++) {
				for (let cx = x; cx < x + width; cx++) {
					if (occupied.has(cellKey(cx, cy))) {
						free = false;
						break;
					}
				}
			}
			if (free) return { x, y };
		}
	}
}

/**
 * Resolve persisted/raw placements: accepts legacy `string[]` ids and
 * `{id,width,height,x,y}` objects, drops unknown ids, collapses duplicates
 * (first occurrence wins) and returns registry order regardless of input order.
 * A missing or non-numeric size falls back to the registry default; numeric
 * sizes are clamped into the bound range (height against the per-widget
 * minimum). An entry with a finite `x`/`y` pair is honoured (clamped so
 * `x + width <= columns` and `y >= 0`); every other entry is auto-positioned.
 *
 * Auto-position rule (deterministic): explicit positions are reserved first,
 * then unpositioned entries are placed in registry order at the first free slot
 * found scanning row-major from the top-left, so a widget never overlaps one
 * already placed and the same input always yields the same layout. The returned
 * order stays registry order. Never throws.
 */
export function resolvePlacements(raw: unknown): WidgetPlacement[] {
	if (!Array.isArray(raw)) return [];
	const requested = new Map<
		WidgetId,
		{ width?: number; height?: number; x?: number; y?: number }
	>();
	for (const entry of raw) {
		const parsed = parsePlacement(entry);
		if (parsed && !requested.has(parsed.id)) {
			requested.set(parsed.id, {
				width: parsed.width,
				height: parsed.height,
				x: parsed.x,
				y: parsed.y
			});
		}
	}

	// Resolve sizes (and any explicit position) in registry order.
	const resolved: WidgetPlacement[] = WIDGET_DEFS.filter((def) => requested.has(def.id)).map(
		(def) => {
			const override = requested.get(def.id);
			const width = override?.width === undefined ? def.width : clampWidth(override.width);
			const height =
				override?.height === undefined
					? def.height
					: clampWidgetHeight(def.id, override.height);
			const position = resolveExplicitPosition(override, width);
			return { id: def.id, width, height, x: position?.x, y: position?.y };
		}
	);

	// Reserve honoured positions, then auto-place the rest.
	const occupied = new Set<number>();
	for (const placement of resolved) {
		if (placement.x !== undefined && placement.y !== undefined) {
			occupy(occupied, placement.x, placement.y, placement.width, placement.height);
		}
	}
	for (const placement of resolved) {
		if (placement.x !== undefined && placement.y !== undefined) continue;
		const slot = firstFreeSlot(occupied, placement.width, placement.height);
		placement.x = slot.x;
		placement.y = slot.y;
		occupy(occupied, slot.x, slot.y, placement.width, placement.height);
	}
	return resolved;
}
