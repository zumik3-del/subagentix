<script lang="ts">
	/**
	 * Top-tools widget body (dashboard Phase 4, task #413).
	 *
	 * Tier-P horizontal bars: `useWidgetData` fetches `/api/dashboard/top-tools`
	 * for the shared filter and `WidgetCard` renders the loading/error/empty
	 * states. A ready payload is drawn by the hand-rolled `BarChart` (no chart
	 * library): the bar length is the call count, the row detail shows the error
	 * share, and the two together are the accessible value. The payload is an
	 * object, so the default emptiness rule always sees it as non-empty — a
	 * custom `isEmpty` keeps the card's standard empty state.
	 *
	 * `getTopTools` caps its `part` scan at `MAX_TOOL_SESSIONS` (the Tier-P
	 * ceiling) and flags `capped`; `period=all` is also the unbounded slow path.
	 * Either case renders the visible note from {@link topToolsNote}.
	 */
	import type { ToolUsage } from '$lib/model/dashboard';
	import type { WidgetBodyProps } from './widget';
	import { useWidgetData } from './data.svelte';
	import { topToolBars, topToolsNote } from './top-tools';
	import WidgetCard from './WidgetCard.svelte';
	import BarChart from './BarChart.svelte';

	let { widget, filter, refreshToken, onSettings }: WidgetBodyProps = $props();

	const state = useWidgetData<ToolUsage>({
		source: () => widget.source,
		filter: () => filter,
		refreshToken: () => refreshToken,
		isEmpty: (usage) => usage.tools.length === 0
	});

	/** `BarChart` rows: call counts with the error share as the row detail. */
	let bars = $derived(state.data ? topToolBars(state.data) : []);

	/** Capped/all-period explanation, or `null` when the counts are exact. */
	let note = $derived(state.data ? topToolsNote(state.data, filter.period) : null);
</script>

<WidgetCard
	title={widget.title}
	status={state.status}
	error={state.error ?? undefined}
	refreshing={state.refreshing}
	onRefresh={state.refresh}
	{onSettings}
>
	{#if state.data}
		{#if note}
			<p class="top-tools__note">{note}</p>
		{/if}
		<BarChart {bars} label="Top tools" limit={bars.length} colorVar="--chart-4" />
	{/if}
</WidgetCard>

<style>
	.top-tools__note {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--text-weak);
	}
</style>
