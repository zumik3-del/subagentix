<script lang="ts">
	/**
	 * Responsive widget grid (dashboard Phase 3, task #404; resizable in #438).
	 *
	 * A 4-column desktop grid whose rows are 6rem tall, with
	 * `grid-auto-flow: row dense` so a short widget backfills the gap beside a
	 * taller one. Each placement's `width` (1–4 quarter-width blocks) and
	 * `height` (1–8 rows) drive `data-w`/`data-h`, so sizing stays declarative
	 * in CSS (numeric attribute selectors, no inline `grid-template`). Secondary
	 * breakpoints clamp: ≤64rem → 2 columns (width capped at 2), ≤40rem → 1
	 * column (always full width); height spans stay valid everywhere.
	 * Each cell is a `WidgetHost` (task #409): SSR renders its skeleton, the
	 * client mounts the widget body lazily once it is visible.
	 */
	import type { DashboardFilter } from '$lib/model/dashboard';
	import { findWidgetDef, type WidgetId, type WidgetPlacement } from '$lib/widgets/registry';
	import type { WidgetLoaders } from './widget';
	import WidgetHost from './WidgetHost.svelte';

	interface Props {
		/** Widget placements to render, in registry order. */
		placements: readonly WidgetPlacement[];
		/**
		 * Optional per-widget code-split loaders (task #409 seam). Ids without a
		 * loader render the static skeleton; `loaders.ts` registers the Phase 3
		 * placeholder bodies and Phase 4 swaps them for the chart bodies.
		 */
		loaders?: WidgetLoaders;
		/** Active global filter, forwarded to every mounted widget body. */
		filter?: DashboardFilter;
		/** Global refresh counter, forwarded to every mounted widget body. */
		refreshToken?: number;
		/** Opens the size-settings modal for a widget id (task #449). */
		onWidgetSettings?: (id: WidgetId) => void;
	}

	const DEFAULT_FILTER: DashboardFilter = { period: '30d', scope: null };

	let {
		placements,
		loaders = {},
		filter = DEFAULT_FILTER,
		refreshToken = 0,
		onWidgetSettings
	}: Props = $props();

	/**
	 * A per-widget gear callback bound to the shell's settings hook (task #449).
	 * The closure is recreated each render, but it is not part of the widget fetch
	 * key (source/period/scope), so opening or changing a size never re-fetches.
	 */
	function settingsFor(id: WidgetId): (() => void) | undefined {
		if (!onWidgetSettings) return undefined;
		return () => onWidgetSettings(id);
	}
</script>

<ul class="widget-grid">
	{#each placements as placement (placement.id)}
		{@const def = findWidgetDef(placement.id)}
		<li class="widget-grid__item" data-w={placement.width} data-h={placement.height}>
			<WidgetHost
				{def}
				load={loaders[def.id]}
				widgetProps={{ widget: def, filter, refreshToken, onSettings: settingsFor(def.id) }}
			/>
		</li>
	{/each}
</ul>

<style>
	.widget-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		grid-auto-rows: 6rem;
		grid-auto-flow: row dense;
		gap: var(--space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.widget-grid__item {
		grid-row: span 1;
		min-width: 0;
	}

	.widget-grid__item[data-w='1'] {
		grid-column: span 1;
	}

	.widget-grid__item[data-w='2'] {
		grid-column: span 2;
	}

	.widget-grid__item[data-w='3'] {
		grid-column: span 3;
	}

	.widget-grid__item[data-w='4'] {
		grid-column: span 4;
	}

	.widget-grid__item[data-h='1'] {
		grid-row: span 1;
	}

	.widget-grid__item[data-h='2'] {
		grid-row: span 2;
	}

	.widget-grid__item[data-h='3'] {
		grid-row: span 3;
	}

	.widget-grid__item[data-h='4'] {
		grid-row: span 4;
	}

	.widget-grid__item[data-h='5'] {
		grid-row: span 5;
	}

	.widget-grid__item[data-h='6'] {
		grid-row: span 6;
	}

	.widget-grid__item[data-h='7'] {
		grid-row: span 7;
	}

	.widget-grid__item[data-h='8'] {
		grid-row: span 8;
	}

	@media (max-width: 63.99rem) {
		.widget-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		/* Width clamps to the two available columns. */
		.widget-grid__item[data-w='3'],
		.widget-grid__item[data-w='4'] {
			grid-column: span 2;
		}
	}

	@media (max-width: 39.99rem) {
		.widget-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		/* Single column: every widget is full width regardless of `data-w`. */
		.widget-grid__item[data-w] {
			grid-column: 1 / -1;
		}
	}
</style>
