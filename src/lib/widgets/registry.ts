/**
 * Dashboard widget registry (dashboard Phase 1, task #402; resizable in #438).
 *
 * The single client-safe source of widget identity, aggregation tier, default
 * placement and default membership, mirroring spec §2.1. Imported by both SSR
 * and client code (and by the settings store for ordering), so it must stay
 * free of `$lib/server` / DB imports and of any DOM/Svelte dependency. Pure and
 * deterministic; no I/O.
 *
 * Geometry (column count, row/gap px, size bounds) comes from the pure
 * `layout.ts` module so the model, the CSS fallback and the future gridstack
 * config share one source; the bounds are re-exported here for existing
 * consumers.
 */
import {
	GRID_COLUMNS,
	WIDGET_MAX_HEIGHT,
	WIDGET_MAX_WIDTH,
	WIDGET_MIN_HEIGHT,
	WIDGET_MIN_WIDTH
} from '$lib/components/features/dashboard/layout';

/**
 * Size bounds re-exported from `layout.ts` (the shared geometry source): width
 * counts quarter-width blocks (4 = full row), height counts 6rem rows. Kept as
 * named exports so existing importers are unaffected by the move.
 */
export { WIDGET_MAX_HEIGHT, WIDGET_MAX_WIDTH, WIDGET_MIN_HEIGHT, WIDGET_MIN_WIDTH };

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
	/** Width in quarter-width blocks (1–4). */
	width: number;
	/** Height in 6rem rows (1–8). */
	height: number;
	/** Optional 0-based column index; both `x` and `y` must be present to take effect. */
	x?: number;
	/** Optional 0-based row index; both `x` and `y` must be present to take effect. */
	y?: number;
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

/** Every registered id, in registry order. */
export const WIDGET_IDS: readonly WidgetId[] = WIDGET_DEFS.map((def) => def.id);

const WIDGET_ID_SET: ReadonlySet<string> = new Set(WIDGET_IDS);

/** Type guard for untrusted input (settings file, URL, API payloads). */
export function isWidgetId(value: unknown): value is WidgetId {
	return typeof value === 'string' && WIDGET_ID_SET.has(value);
}

/**
 * The first-visit default placements, in registry order. Derived from
 * {@link WIDGET_DEFS} so `defaultOn`/default sizes stay the single source of
 * truth; the grid positions are resolved through {@link resolvePlacements} so
 * every default widget is positioned with no overlap (first visit renders a
 * packed grid, never a stack of unplaced widgets).
 */
export const DEFAULT_WIDGETS: readonly WidgetPlacement[] = resolvePlacements(
	WIDGET_DEFS.filter((def) => def.defaultOn).map((def) => ({
		id: def.id,
		width: def.width,
		height: def.height
	}))
);

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
