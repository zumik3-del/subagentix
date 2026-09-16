<script lang="ts">
	/**
	 * Sessions-per-day widget body (dashboard Phase 4, task #411).
	 *
	 * Tier-S time series: `useWidgetData` fetches `/api/dashboard/sessions-per-day`
	 * for the shared filter, and `WidgetCard` renders the loading/error/empty
	 * states. A ready payload is drawn by the shared `TimeSeriesChart` (uPlot).
	 */
	import { formatNumber } from '$lib/model/format';
	import type { DayBucket } from '$lib/model/chart';
	import type { WidgetBodyProps } from './widget';
	import { useWidgetData } from './data.svelte';
	import WidgetCard from './WidgetCard.svelte';
	import TimeSeriesChart from './TimeSeriesChart.svelte';

	let { widget, filter, refreshToken }: WidgetBodyProps = $props();

	const state = useWidgetData<DayBucket[]>({
		source: () => widget.source,
		filter: () => filter,
		refreshToken: () => refreshToken
	});
</script>

<WidgetCard
	title={widget.title}
	status={state.status}
	error={state.error ?? undefined}
	refreshing={state.refreshing}
	onRefresh={state.refresh}
>
	{#if state.data}
		<TimeSeriesChart
			points={state.data}
			label="Sessions"
			colorVar="--chart-1"
			formatValue={formatNumber}
		/>
	{/if}
</WidgetCard>
