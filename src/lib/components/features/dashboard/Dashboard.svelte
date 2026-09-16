<script lang="ts">
	/**
	 * Dashboard shell root (dashboard Phase 3, task #404).
	 *
	 * Owns the selected-widget set (seeded from settings via the page loader)
	 * and composes the header + responsive grid. The header's `actions` slot
	 * hosts the global period/project selector (#415) and the "Widgets" picker
	 * button (#414). The filter is a prop with a default so the shell renders
	 * standalone; the landing page supplies it from URL state and receives every
	 * selector change through `onFilterChange` (no persistence here). Each
	 * selected widget mounts lazily and fetches its own data through the grid's
	 * loaders, re-fetching whenever the filter prop changes (tasks #410/#415).
	 */
	import type { DashboardFilter } from '$lib/model/dashboard';
	import { resolvePlacements, type WidgetPlacement } from '$lib/widgets/registry';
	import DashboardHeader from './DashboardHeader.svelte';
	import FilterSelector from './FilterSelector.svelte';
	import WidgetGrid from './WidgetGrid.svelte';
	import WidgetsModal from './WidgetsModal.svelte';
	import { DEFAULT_PERIOD, type FilterOption } from './filter';
	import { WIDGET_LOADERS } from './loaders';

	const DEFAULT_FILTER: DashboardFilter = { period: DEFAULT_PERIOD, scope: null };

	interface Props {
		/** Selected widget placements, already normalised by the settings store. */
		widgets: readonly WidgetPlacement[];
		/** Active global filter; the page derives it from `?period=&scope=`. */
		filter?: DashboardFilter;
		/** Global refresh counter; a change refetches every active widget. */
		refreshToken?: number;
		/** Directory options for the scope selector (no `All projects` entry). */
		scopes?: readonly FilterOption[];
		/** Selector callback; the page turns it into a `goto` URL update. */
		onFilterChange?: (filter: DashboardFilter) => void;
	}

	let {
		widgets,
		filter = DEFAULT_FILTER,
		refreshToken = 0,
		scopes = [],
		onFilterChange
	}: Props = $props();

	// Applied selection: starts from the loader, and an Apply replaces it with
	// the normalised placements the settings API returned, so the grid
	// re-renders without a full reload (task #414). A later loader refresh still
	// wins until the next Apply.
	let applied = $state<WidgetPlacement[] | null>(null);
	let pickerOpen = $state(false);

	// Registry order + dedupe + clamp, so the grid always matches the picker.
	let placements = $derived(resolvePlacements(applied ?? widgets));

	function onApply(next: readonly WidgetPlacement[]): void {
		applied = [...next];
		pickerOpen = false;
	}
</script>

<main class="dashboard">
	<DashboardHeader>
		{#snippet actions()}
			<FilterSelector {filter} {scopes} onChange={onFilterChange} />
			<button type="button" class="ui-btn" onclick={() => (pickerOpen = true)}>Widgets</button>
		{/snippet}
	</DashboardHeader>

	{#if placements.length === 0}
		<p class="dashboard__empty">
			No widgets selected. Use the Widgets button to add widgets to your dashboard.
		</p>
	{:else}
		<WidgetGrid {placements} loaders={WIDGET_LOADERS} {filter} {refreshToken} />
	{/if}
</main>

<WidgetsModal
	open={pickerOpen}
	selected={placements}
	onApply={onApply}
	onClose={() => (pickerOpen = false)}
/>

<style>
	.dashboard {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
		padding: var(--space-6) var(--space-8) var(--space-12);
	}

	.dashboard__empty {
		margin: 0;
		padding: var(--space-12) var(--space-8);
		border: 1px dashed var(--border-weak-base);
		border-radius: var(--radius-lg);
		text-align: center;
		color: var(--text-weak);
	}
</style>
