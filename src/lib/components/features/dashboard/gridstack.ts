/**
 * gridstack enhancement wrapper (epic #462, stage 3).
 *
 * The single owner of every gridstack interaction on the dashboard grid. It is
 * attached by `WidgetGrid.svelte` as a Svelte action (`use:`), so it runs on the
 * client only — never during SSR — and both the library and its stylesheet are
 * dynamically imported, so they live in their own chunk and are fetched only
 * when the desktop enhancement actually starts.
 *
 * Contract:
 * - **Gate.** The enhancement is desktop-only: it starts only when `matchMedia`
 *   matches `layout.ts`'s 6-column breakpoint (`GRID_DESKTOP_MIN_WIDTH_REM`).
 *   Below it (and on the server) the grid stays the static CSS fallback owned by
 *   `WidgetGrid.svelte`; crossing the breakpoint tears the enhancement down.
 * - **Adopt, don't create.** `GridStack.init` reads the `grid-stack-item` /
 *   `gs-*` / `grid-stack-item-content` markup the component already rendered, so
 *   no item DOM is created here. Just before adopting, the component is told via
 *   `onActiveChange(true)` to freeze each item's gridstack view (its `gs-*`
 *   attributes and `--gs-*` inline style), so Svelte never rewrites what
 *   gridstack owns; every later mutation goes through the gridstack API.
 * - **Persist on settle.** A `dragstop`/`resizestop` reads the whole layout back
 *   from the live engine nodes and hands it to `onLayoutChange` — exactly one
 *   call per settled gesture. Pointer moves, programmatic syncs and init never
 *   call it (except the one-time overlap repair described below).
 * - **Safe fallback.** Any import or init failure is caught here and swallowed:
 *   the DOM is restored to the static fallback and `onActiveChange(false)` keeps
 *   the component's reactive (JS-only) path live. No unhandled rejection.
 *
 * Overlap repair: `resolvePlacements` honours explicit `x`/`y` and does not
 * repair explicit-vs-explicit collisions, so a stored file can hold two widgets
 * at the same cell. gridstack's `_fixCollisions` moves one of them at init; this
 * wrapper then compares the live layout with the model and emits the corrected
 * list through the same `onLayoutChange` hop, so the persisted file is fixed
 * rather than left inconsistent. This fires at most once per activation and only
 * when the live layout actually differs.
 */
import {
	GRID_COLUMNS,
	GRID_DESKTOP_MIN_WIDTH_REM,
	GRID_GAP_REM,
	GRID_ROW_HEIGHT_REM,
	WIDGET_MAX_HEIGHT,
	WIDGET_MAX_WIDTH,
	WIDGET_MIN_HEIGHT,
	WIDGET_MIN_WIDTH
} from './layout';
import { findWidgetDef, resolvePlacements } from '$lib/widgets/registry';
import type { WidgetId, WidgetPlacement } from '$lib/widgets/registry';
// Type-only, so the emitted wrapper has no static reference to the library.
import type { GridItemHTMLElement, GridStack } from 'gridstack';

/** Desktop-only gate, mirroring the `min-width: 64rem` fallback query. */
const DESKTOP_QUERY = `(min-width: ${GRID_DESKTOP_MIN_WIDTH_REM}rem)`;

/** Classes gridstack's drag&drop layer adds to items; removed on teardown. */
const DD_ITEM_CLASSES = [
	'ui-draggable',
	'ui-draggable-disabled',
	'ui-draggable-dragging',
	'ui-draggable-armed',
	'ui-resizable',
	'ui-resizable-disabled',
	'ui-resizable-resizing',
	'ui-resizable-autohide'
];

/** Container properties gridstack sets inline; removed on teardown. */
const CONTAINER_STYLE_PROPS = [
	'height',
	'min-height',
	'--gs-column-width',
	'--gs-columns',
	'--gs-cell-height'
];

/** Positioning properties gridstack sets inline on each item; removed on teardown. */
const ITEM_STYLE_PROPS = ['position', 'left', 'right', 'top', 'bottom', 'width', 'height'];

export interface GridstackEnhanceParam {
	/** Current placements; used to adopt, remove and update nodes imperatively. */
	placements: readonly WidgetPlacement[];
	/** Called once per settled gesture with the full list, positions included. */
	onLayoutChange: (placements: WidgetPlacement[]) => void;
	/** `true` just before gridstack adopts the DOM, `false` after teardown/failed init. */
	onActiveChange: (active: boolean) => void;
}

/**
 * Svelte action: create the controller on mount and keep it in sync afterwards.
 * `destroy` runs on unmount; `update` receives the fresh param on every render.
 */
export function gridstackEnhance(container: HTMLElement, param: GridstackEnhanceParam) {
	const controller = new GridstackController(container, param);
	return {
		update(next: GridstackEnhanceParam): void {
			controller.update(next);
		},
		destroy(): void {
			controller.destroy();
		}
	};
}

class GridstackController {
	#container: HTMLElement;
	#placements: readonly WidgetPlacement[];
	#onLayoutChange: GridstackEnhanceParam['onLayoutChange'];
	#onActiveChange: GridstackEnhanceParam['onActiveChange'];

	#grid: GridStack | null = null;
	#query: MediaQueryList | null = null;
	/** True from `onActiveChange(true)` until teardown, grid instance or not. */
	#active = false;
	#starting = false;
	#destroyed = false;
	/** At most one persisted overlap repair per activation. */
	#repaired = false;

	constructor(container: HTMLElement, param: GridstackEnhanceParam) {
		this.#container = container;
		this.#placements = param.placements;
		this.#onLayoutChange = param.onLayoutChange;
		this.#onActiveChange = param.onActiveChange;

		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
		this.#query = window.matchMedia(DESKTOP_QUERY);
		this.#query.addEventListener('change', this.#handleBreakpoint);
		if (this.#query.matches) void this.#start();
	}

	/** Re-read the model and drive gridstack imperatively (picker add/remove, sizes). */
	update(param: GridstackEnhanceParam): void {
		this.#placements = param.placements;
		this.#onLayoutChange = param.onLayoutChange;
		this.#onActiveChange = param.onActiveChange;
		if (this.#grid) this.#sync(param.placements);
	}

	/** Unmount: stop listening and restore the static layout. */
	destroy(): void {
		this.#destroyed = true;
		this.#query?.removeEventListener('change', this.#handleBreakpoint);
		this.#teardown();
	}

	#handleBreakpoint = (event: MediaQueryListEvent): void => {
		if (event.matches) void this.#start();
		else this.#teardown();
	};

	/** Load the chunk and adopt the existing DOM; never throws out of the action. */
	async #start(): Promise<void> {
		if (this.#destroyed || this.#starting || this.#grid || !this.#query?.matches) return;
		this.#starting = true;
		try {
			const [gridstack] = await Promise.all([
				import('gridstack'),
				import('gridstack/dist/gridstack.min.css')
			]);
			// The breakpoint may have been crossed while the chunk was loading.
			if (this.#destroyed || !this.#query.matches) return;

			// Freeze the component's item views before gridstack writes its own.
			this.#active = true;
			this.#onActiveChange(true);
			this.#container.classList.add('grid-stack');

			const grid = gridstack.GridStack.init(
				{
					column: GRID_COLUMNS,
					cellHeight: `${GRID_ROW_HEIGHT_REM}rem`,
					margin: `${GRID_GAP_REM}rem`,
					// Keep exact positions: `float: false` (gridstack's default) applies
					// top-gravity packing that would silently compact stored gaps on
					// load, diverging from the CSS fallback and triggering a repair PUT.
					float: true,
					animate: false,
					// Resize surface made explicit instead of relying on gridstack's
					// built-ins: east/south/southeast only. No north-west/north-east/
					// south-west handle is created, so nothing can paint at an item's
					// top-left. `alwaysShowResizeHandle: false` keeps the handles
					// auto-hidden until the item is hovered (its default is `'mobile'`).
					resizable: { handles: 'e,s,se' },
					alwaysShowResizeHandle: false
				},
				this.#container
			);
			if (!grid) throw new Error('gridstack did not initialise');

			this.#grid = grid;
			this.#repaired = false;
			grid.on('dragstop', this.#handleGesture);
			grid.on('resizestop', this.#handleGesture);
			this.#sync(this.#placements);
			this.#repair();
		} catch {
			// Silent fallback: keep the static layout and the reactive path.
			this.#teardown();
		} finally {
			this.#starting = false;
		}
	}

	#handleGesture = (): void => {
		if (!this.#grid || !this.#active) return;
		this.#onLayoutChange(this.#readLayout());
	};

	/**
	 * Reconcile gridstack with the model without triggering a persist: nodes the
	 * model dropped are removed with `removeDOM=false` (Svelte owns the `<li>`),
	 * items the model added are adopted via `makeWidget`, and every node's bounds
	 * and size are pushed from the model.
	 */
	#sync(placements: readonly WidgetPlacement[]): void {
		const grid = this.#grid;
		if (!grid) return;
		grid.batchUpdate();
		try {
			const wanted = new Set(placements.map((placement) => placement.id));
			// Iterate the engine nodes, not `getGridItems()`: by the time this runs
			// Svelte may already have detached the `<li>` of a removed widget, and
			// a detached node must still be dropped from the engine.
			for (const node of [...grid.engine.nodes]) {
				const id = node.id as WidgetId | undefined;
				if (node.el && (!id || !wanted.has(id))) grid.removeWidget(node.el, false, false);
			}
			for (const placement of placements) {
				const el = this.#itemEl(placement.id);
				if (!el) continue;
				if (!el.gridstackNode) grid.makeWidget(el);
				grid.update(el, {
					minW: WIDGET_MIN_WIDTH,
					maxW: WIDGET_MAX_WIDTH,
					minH: findWidgetDef(placement.id).minHeight,
					maxH: WIDGET_MAX_HEIGHT,
					w: placement.width,
					h: placement.height,
					...positionOf(placement)
				});
			}
		} finally {
			grid.batchUpdate(false);
		}
	}

	/** Persist gridstack's repaired layout once when it differs from the model. */
	#repair(): void {
		if (this.#repaired) return;
		const live = this.#readLayout();
		if (sameGeometry(live, this.#placements)) return;
		this.#repaired = true;
		this.#onLayoutChange(live);
	}

	/**
	 * Read the live layout back into model placements (full list, x/y included).
	 *
	 * Reads `grid.engine.nodes` directly, deliberately **not** `grid.save(false)`.
	 * `Utils.removeInternalForSave` (gridstack 13.3, `dist/utils.js:493-496`)
	 * deletes `w` when `w === 1 || w === minW` and `h` when `h === 1 || h ===
	 * minH`, so a saved node that shrank to width 1 (or to the widget's
	 * `minHeight`) comes back without those keys. Compensating with the previous
	 * model value (as this used to) then reported the *old* size, which was
	 * persisted and pushed back through `#sync` — the widget snapped back. The
	 * engine nodes are the source of truth and `prepareNode` guarantees numeric,
	 * in-bounds `x`/`y`/`w`/`h` (each clamped to ≥ 1), so the `??` floors below
	 * only cover a type-optional field and can never resurrect a stale size.
	 * Only model-known ids are reported, so a removed widget is never readded.
	 */
	#readLayout(): WidgetPlacement[] {
		const grid = this.#grid;
		if (!grid) return [...this.#placements];
		const known = new Set(this.#placements.map((placement) => placement.id));
		const raw: WidgetPlacement[] = [];
		for (const node of grid.engine.nodes) {
			const id = node.id as WidgetId | undefined;
			if (!id || !known.has(id)) continue;
			raw.push({
				id,
				width: node.w ?? WIDGET_MIN_WIDTH,
				height: node.h ?? WIDGET_MIN_HEIGHT,
				x: node.x ?? 0,
				y: node.y ?? 0
			});
		}
		return resolvePlacements(raw);
	}

	#itemEl(id: WidgetId): GridItemHTMLElement | null {
		return this.#container.querySelector<GridItemHTMLElement>(`[gs-id="${id}"]`);
	}

	/**
	 * Destroy the grid without removing DOM (`destroy(false)` leaves the nodes so
	 * Svelte keeps owning them), then strip every inline style, class and resize
	 * handle gridstack added, so the fallback renders from a clean slate.
	 */
	#teardown(): void {
		const grid = this.#grid;
		this.#grid = null;
		if (grid) {
			try {
				grid.destroy(false);
			} catch {
				// Teardown must never throw back into the component.
			}
		}
		const wasActive = this.#active;
		this.#active = false;
		this.#cleanupDom();
		// On unmount the component is already going away; updating its state would
		// only be a teardown-time write, so skip it there.
		if (wasActive && !this.#destroyed) this.#onActiveChange(false);
	}

	#cleanupDom(): void {
		const container = this.#container;
		container.classList.remove('grid-stack', `gs-${GRID_COLUMNS}`, 'grid-stack-animate');
		container.removeAttribute('gs-current-row');
		for (const property of CONTAINER_STYLE_PROPS) container.style.removeProperty(property);

		for (const el of container.querySelectorAll<HTMLElement>('.grid-stack-item')) {
			for (const property of ITEM_STYLE_PROPS) el.style.removeProperty(property);
			el.classList.remove(...DD_ITEM_CLASSES);
			for (const handle of el.querySelectorAll('.ui-resizable-handle')) handle.remove();
		}
	}
}

/** `{x,y}` only when both are present; a partial pair must not override gridstack. */
function positionOf(placement: WidgetPlacement): { x: number; y: number } | Record<string, never> {
	return placement.x !== undefined && placement.y !== undefined
		? { x: placement.x, y: placement.y }
		: {};
}

/** Same widgets at the same size and position (order-insensitive, x/y included). */
function sameGeometry(a: readonly WidgetPlacement[], b: readonly WidgetPlacement[]): boolean {
	if (a.length !== b.length) return false;
	const byId = new Map(b.map((placement) => [placement.id, placement] as const));
	for (const placement of a) {
		const other = byId.get(placement.id);
		if (
			!other ||
			other.width !== placement.width ||
			other.height !== placement.height ||
			other.x !== placement.x ||
			other.y !== placement.y
		) {
			return false;
		}
	}
	return true;
}
