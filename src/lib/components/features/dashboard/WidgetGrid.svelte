<script lang="ts">
	/**
	 * Responsive widget grid (dashboard Phase 3, task #404; resizable in #438;
	 * free-form markup seam in #465).
	 *
	 * One markup tree serves two modes, so the page keeps working with
	 * JavaScript disabled or before the enhancement chunk loads:
	 *
	 * - **Fallback (SSR / no JS):** the `<ul>` is a 6-column CSS grid with
	 *   `3rem` rows and `grid-auto-flow: row dense`, driven entirely by the
	 *   `widget-grid` class. Each item's `width`/`height` still feed the
	 *   `data-w` numeric table and the `--gs-h` row span, and its resolved
	 *   `x`/`y` are exposed as the `--gs-*` custom properties: at `≥64rem`
	 *   those pin the widget to its exact cell (no overflow, no flow packing),
	 *   while the `≤63.99rem` (2 columns, width capped at 2) and `≤39.99rem`
	 *   (1 column, full width) blocks keep the old clamp behaviour. The
	 *   container never carries `grid-stack` here — that class is added only on
	 *   the enhancement path in a later stage, never during SSR.
	 * - **Enhancement (later stage):** the same nodes already carry the
	 *   gridstack contract — `grid-stack-item` on each item, `gs-x`/`gs-y`/
	 *   `gs-w`/`gs-h` attributes, and the `grid-stack-item-content` wrapper
	 *   around the body — so gridstack can adopt the existing DOM without a
	 *   rewrite once its stylesheet is loaded.
	 *
	 * Grid geometry (columns, row height, gap) comes from the pure `layout.ts`
	 * constants, surfaced to CSS as the `--grid-*` custom properties set on the
	 * `<ul>`; the per-widget `--gs-*` values come from the resolved placement.
	 * Each cell is a `WidgetHost` (task #409): SSR renders its skeleton, the
	 * client mounts the widget body lazily once it is visible.
	 */
	import type { DashboardFilter } from '$lib/model/dashboard';
	import {
		findWidgetDef,
		type WidgetId,
		type WidgetPlacement,
		type WidgetSettingValues
	} from '$lib/widgets/registry';
	import { GRID_COLUMNS, GRID_GAP_HALF_REM, GRID_GAP_REM, GRID_ROW_HEIGHT_REM } from './layout';
	import { DEFAULT_FILTER } from './filter';
	import { gridstackEnhance } from './gridstack';
	import WidgetHost from './WidgetHost.svelte';

	interface Props {
		/** Widget placements to render, in registry order. */
		placements: readonly WidgetPlacement[];
		/** Active global filter, forwarded to every mounted widget body. */
		filter?: DashboardFilter;
		/** Global refresh counter, forwarded to every mounted widget body. */
		refreshToken?: number;
		/** Settings map (by widget id), forwarded to each widget's fetch (task #520). */
		settings?: Record<WidgetId, WidgetSettingValues>;
		/** Opens the settings modal for a widget id (task #449). */
		onWidgetSettings?: (id: WidgetId) => void;
		/**
		 * Persistence hop for the gridstack enhancement (epic #462, stage 3):
		 * called once per settled drag/resize with the full placement list,
		 * positions included. The grid stays presentational — the shell owns the
		 * write; this component only forwards what the wrapper reported.
		 */
		onLayoutChange?: (placements: WidgetPlacement[]) => void;
	}

	let {
		placements,
		filter = DEFAULT_FILTER,
		refreshToken = 0,
		// Standalone default (no shell): every widget falls back to no settings.
		settings = {} as Record<WidgetId, WidgetSettingValues>,
		onWidgetSettings,
		onLayoutChange
	}: Props = $props();

	/**
	 * The shared `layout.ts` geometry, exposed to the stylesheet as custom
	 * properties so the CSS consumes the constants instead of repeating them
	 * (the two media-query breakpoints are the only values CSS cannot read from
	 * a custom property).
	 */
	const gridVars = `--grid-columns:${GRID_COLUMNS};--grid-row-height:${GRID_ROW_HEIGHT_REM}rem;--grid-gap:${GRID_GAP_REM}rem;--grid-gap-half:${GRID_GAP_HALF_REM}rem`;

	/**
	 * Per-item fallback placement (epic #462, stage 2): the resolved 0-based
	 * `x`/`y` plus the `width`/`height` spans, so the desktop CSS can pin a cell
	 * without inline `grid-template`. `x`/`y` are always resolved upstream
	 * (`resolvePlacements`); the `0` floor only keeps a partial pair from
	 * leaking `undefined` into the custom property.
	 */
	function placementVars(placement: WidgetPlacement): string {
		return `--gs-x:${placement.x ?? 0};--gs-y:${placement.y ?? 0};--gs-w:${placement.width};--gs-h:${placement.height}`;
	}

	/**
	 * The gridstack placement attributes for an item. Kept as a spread object
	 * because `gs-x`/`gs-y`/`gs-w`/`gs-h`/`gs-id` are gridstack's contract, not
	 * typed `<li>` attributes; a value that is absent (`undefined`) is omitted
	 * from the markup rather than stringified. `gs-id` is how the wrapper finds
	 * a node again (`grid.save()` returns it and `#sync` matches by id).
	 */
	function placementAttrs(placement: WidgetPlacement): Record<string, string | number | undefined> {
		return {
			'gs-id': placement.id,
			'gs-x': placement.x,
			'gs-y': placement.y,
			'gs-w': placement.width,
			'gs-h': placement.height
		};
	}

	/** One item's full gridstack contract: the spread attributes plus its inline style. */
	interface GridstackItemView {
		attrs: Record<string, string | number | undefined>;
		style: string;
	}

	function buildItemView(placement: WidgetPlacement): GridstackItemView {
		return { attrs: placementAttrs(placement), style: placementVars(placement) };
	}

	/** True from the wrapper's `onActiveChange(true)` until it tears down. */
	let enhanced = $state(false);

	/**
	 * The enhanced-mode "freeze" (epic #462, stage 3): once gridstack owns an
	 * item, Svelte must not write that item's `gs-*` attributes or its inline
	 * style again, or `set_style`'s `cssText` replacement would wipe gridstack's
	 * `left/top/width/height` and silently desync the layout. This memo holds the
	 * value each item had at the moment the enhancement started; because it is
	 * deliberately **not** reactive it never triggers a render, and returning the
	 * same string makes Svelte's own value cache a no-op (no DOM write). New
	 * widgets are captured lazily, removed ones are pruned, and the whole memo is
	 * dropped on deactivation so the fallback renders reactively again.
	 */
	const frozenViews = new Map<WidgetId, GridstackItemView>();

	function gridstackItemView(placement: WidgetPlacement): GridstackItemView {
		if (!enhanced) return buildItemView(placement);
		let view = frozenViews.get(placement.id);
		if (!view) {
			view = buildItemView(placement);
			frozenViews.set(placement.id, view);
		}
		return view;
	}

	/** Keep the freeze memo to exactly the widgets that are currently rendered. */
	$effect(() => {
		if (!enhanced) return;
		const rendered = new Set(placements.map((placement) => placement.id));
		for (const id of frozenViews.keys()) if (!rendered.has(id)) frozenViews.delete(id);
	});

	/** The wrapper reports enhancement start/stop; freeze/unfreeze follows. */
	function onActiveChange(active: boolean): void {
		frozenViews.clear();
		enhanced = active;
	}

	/** Forward a settled gesture to the shell; no-op when the prop is absent. */
	function emitLayout(next: WidgetPlacement[]): void {
		onLayoutChange?.(next);
	}

	/**
	 * A per-widget gear callback bound to the shell's settings hook (task #449).
	 * The closure is recreated each render, but it is not part of the widget fetch
	 * key (source/period/scope/settings signature), so opening the dialog never
	 * re-fetches.
	 */
	function settingsFor(id: WidgetId): (() => void) | undefined {
		if (!onWidgetSettings) return undefined;
		return () => onWidgetSettings(id);
	}
</script>

<ul
	class="widget-grid"
	style={gridVars}
	use:gridstackEnhance={{ placements, onLayoutChange: emitLayout, onActiveChange }}
>
	{#each placements as placement (placement.id)}
		{@const def = findWidgetDef(placement.id)}
		{@const view = gridstackItemView(placement)}
		<li
			class="widget-grid__item grid-stack-item"
			data-w={placement.width}
			data-h={placement.height}
			{...view.attrs}
			style={view.style}
		>
			<div class="grid-stack-item-content">
				<WidgetHost
					{def}
					load={def.load}
					widgetProps={{
						widget: def,
						filter,
						refreshToken,
						settings: settings[def.id] ?? {},
						onSettings: settingsFor(def.id)
					}}
				/>
			</div>
		</li>
	{/each}
</ul>

<style>
	/* Base normalization that must survive BOTH modes. The fallback block below
	   is scoped to `:not(.grid-stack)`, so the moment the enhancement adds
	   `grid-stack` the `<ul>` falls back to browser defaults: its list markers
	   reappear as a small disc at each `<li>`'s top-left (the stray "white
	   circle"), plus the default list margin/padding. Keep them off
	   unconditionally — gridstack positions the items itself, so these only
	   remove native decorations. */
	.widget-grid {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* Enhanced-mode gutter compensation (epic #462). gridstack insets each card
	   by `--grid-gap-half` inside its cell (`margin: GRID_GAP_HALF_REM` in
	   `gridstack.ts`), so a cell edge already sits half a gap inside the
	   container. Pulling the container out by that same half makes the outer
	   card edge land on the page's own `--space-4` (16px) gutter while adjacent
	   cards stay 16px apart — one half-gap on each side of the boundary, never
	   double-counted. The pull-out stays within `.dashboard`'s 16px side
	   padding, so the wider box cannot overflow the viewport. Applies only when
	   gridstack owns the grid; the fallback keeps `gap: var(--grid-gap)`. */
	.widget-grid.grid-stack {
		margin: calc(-1 * var(--grid-gap-half));
	}

	/* Every fallback rule is scoped to `:not(.grid-stack)` (epic #462, stage 3):
	   the enhancement adds `grid-stack` to the `<ul>`, and these `display: grid`
	   / `grid-column` / fixed-row rules must switch off at that point or they
	   would fight gridstack's absolute positioning model. With the class absent
	   (SSR, mobile, or a failed enhancement) they are the whole layout. */

	.widget-grid:not(.grid-stack) {
		display: grid;
		/* Geometry comes from `layout.ts` via the `--grid-*` custom properties
		   set on the `<ul>`: `GRID_COLUMNS`, `GRID_ROW_HEIGHT_REM` (3rem),
		   `GRID_GAP_REM` (1rem, the old `--space-4`). No fresh literals here. */
		grid-template-columns: repeat(var(--grid-columns), minmax(0, 1fr));
		grid-auto-rows: var(--grid-row-height);
		grid-auto-flow: row dense;
		gap: var(--grid-gap);
	}

	.widget-grid:not(.grid-stack) .widget-grid__item {
		/* Height comes from the per-item `--gs-h` custom property (the row span
		   is a numeric `span var(--gs-h)`, valid CSS) instead of a `data-h`
		   lookup table: the table would need one rule per height unit up to
		   `WIDGET_MAX_HEIGHT` (16), the custom property needs none and already
		   holds the resolved value. Width keeps its `data-w` rules below because
		   the two narrow modes still clamp the span. */
		grid-row: span var(--gs-h);
		min-width: 0;
	}

	/* gridstack's body wrapper (adopted verbatim by the enhancement) for the
	   fallback path only. It must pass a definite height down: the chain
	   `li → .grid-stack-item-content → .widget-host → .widget-card`
	   is all `height: 100%`, so the card fills the cell exactly as before and
	   the card's `ResizeObserver` keeps measuring the real row box. While
	   enhanced gridstack sizes the content from its own margins instead, so this
	   rule must not apply then. */
	.widget-grid:not(.grid-stack) .grid-stack-item-content {
		height: 100%;
		min-width: 0;
	}

	.widget-grid:not(.grid-stack) .widget-grid__item[data-w='1'] {
		grid-column: span 1;
	}

	.widget-grid:not(.grid-stack) .widget-grid__item[data-w='2'] {
		grid-column: span 2;
	}

	.widget-grid:not(.grid-stack) .widget-grid__item[data-w='3'] {
		grid-column: span 3;
	}

	.widget-grid:not(.grid-stack) .widget-grid__item[data-w='4'] {
		grid-column: span 4;
	}

	.widget-grid:not(.grid-stack) .widget-grid__item[data-w='5'] {
		grid-column: span 5;
	}

	.widget-grid:not(.grid-stack) .widget-grid__item[data-w='6'] {
		grid-column: span 6;
	}

	/* Desktop (≥ `layout.ts` `GRID_DESKTOP_MIN_WIDTH_REM` = 64rem): every widget
	   is pinned to its resolved `x`/`y`/`width`/`height`, so it can never flow
	   or overlap. Same specificity as the `data-w` table above, but later in
	   source, so it wins there; the narrow blocks below are mutually exclusive
	   with this width and keep their `data-w` behaviour. */
	@media (min-width: 64rem) {
		.widget-grid:not(.grid-stack) .widget-grid__item.grid-stack-item {
			grid-column: calc(var(--gs-x) + 1) / span var(--gs-w);
			grid-row: calc(var(--gs-y) + 1) / span var(--gs-h);
		}
	}

	@media (max-width: 63.99rem) {
		.widget-grid:not(.grid-stack) {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		/* Width clamps to the two available columns: every width above 2 (in the
		   6-column model: 3–6) collapses to the full 2-column span. */
		.widget-grid:not(.grid-stack) .widget-grid__item[data-w='3'],
		.widget-grid:not(.grid-stack) .widget-grid__item[data-w='4'],
		.widget-grid:not(.grid-stack) .widget-grid__item[data-w='5'],
		.widget-grid:not(.grid-stack) .widget-grid__item[data-w='6'] {
			grid-column: span 2;
		}
	}

	@media (max-width: 39.99rem) {
		.widget-grid:not(.grid-stack) {
			grid-template-columns: minmax(0, 1fr);
		}

		/* Single column: every widget is full width regardless of `data-w`. */
		.widget-grid:not(.grid-stack) .widget-grid__item[data-w] {
			grid-column: 1 / -1;
		}
	}
</style>
