<script lang="ts">
	/**
	 * Agent-distribution widget body (dashboard Phase 4, task #412).
	 *
	 * Tier-S donut: `useWidgetData` fetches `/api/dashboard/agent-distribution`
	 * for the shared filter and `WidgetCard` renders the loading/error/empty
	 * states. A ready payload is drawn by the hand-rolled `DonutChart` (no chart
	 * library); agent names map 1:1 onto the donut's `--chart-*` slices.
	 */
	import type { DistributionEntry } from '$lib/model/dashboard';
	import type { WidgetBodyProps } from './widget';
	import { useWidgetData } from './data.svelte';
	import WidgetCard from './WidgetCard.svelte';
	import DonutChart from './DonutChart.svelte';

	let { widget, filter, refreshToken, onSettings }: WidgetBodyProps = $props();

	const state = useWidgetData<DistributionEntry[]>({
		source: () => widget.source,
		filter: () => filter,
		refreshToken: () => refreshToken
	});

	/** Donut input: one labelled slice per agent, in the API's rank order. */
	let slices = $derived(
		(state.data ?? []).map((entry) => ({ label: entry.name, value: entry.count }))
	);
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
		<DonutChart {slices} label="Agent distribution" unit="sessions" />
	{/if}
</WidgetCard>
