<script lang="ts">
	/**
	 * Responsive widget grid (dashboard Phase 3, task #404).
	 *
	 * Fixed footprint per spec §2.7/D8: 12 columns on desktop (≥ 64rem),
	 * 6 on medium, 1 on narrow; within a row, `1x1` spans 4 (3 on medium),
	 * `2x1` spans 8 (6), `full` spans the whole row. No drag-and-drop in v1.
	 * Every child carries a data attribute so the sizing stays declarative.
	 * Each cell is a `WidgetHost` (task #409): SSR renders its skeleton, the
	 * client mounts the widget body lazily once it is visible.
	 */
	import type { DashboardFilter } from '$lib/model/dashboard';
	import type { WidgetDef } from '$lib/widgets/registry';
	import type { WidgetLoaders } from './widget';
	import WidgetHost from './WidgetHost.svelte';

	interface Props {
		/** Widgets to render, in registry order. */
		widgets: readonly WidgetDef[];
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
	}

	const DEFAULT_FILTER: DashboardFilter = { period: '30d', scope: null };

	let {
		widgets,
		loaders = {},
		filter = DEFAULT_FILTER,
		refreshToken = 0
	}: Props = $props();
</script>

<ul class="widget-grid">
	{#each widgets as def (def.id)}
		<li class="widget-grid__item" data-size={def.size}>
			<WidgetHost {def} load={loaders[def.id]} widgetProps={{ widget: def, filter, refreshToken }} />
		</li>
	{/each}
</ul>

<style>
	.widget-grid {
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		gap: var(--space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.widget-grid__item {
		grid-column: span 12;
		min-width: 0;
	}

	.widget-grid__item[data-size='1x1'] {
		grid-column: span 4;
	}

	.widget-grid__item[data-size='2x1'] {
		grid-column: span 8;
	}

	.widget-grid__item[data-size='full'] {
		grid-column: span 12;
	}

	@media (max-width: 63.99rem) {
		.widget-grid {
			grid-template-columns: repeat(6, minmax(0, 1fr));
		}

		.widget-grid__item[data-size='1x1'] {
			grid-column: span 3;
		}

		.widget-grid__item[data-size='2x1'] {
			grid-column: span 6;
		}

		.widget-grid__item[data-size='full'] {
			grid-column: span 6;
		}
	}

	@media (max-width: 39.99rem) {
		.widget-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.widget-grid__item[data-size] {
			grid-column: auto;
		}
	}
</style>
