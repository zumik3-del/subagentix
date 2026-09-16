<script lang="ts">
	/**
	 * Sessions-per-day widget body (dashboard Phase 4, task #411).
	 *
	 * Tier-S time series: `useWidgetData` fetches `/api/dashboard/sessions-per-day`
	 * for the shared filter, and `WidgetCard` renders the loading/error/empty
	 * states. A ready payload is shown as a newest-first day table (`DayTable`).
	 */
	import { formatNumber } from '$lib/model/format';
	import type { DayBucket } from '$lib/model/chart';
	import type { WidgetBodyProps } from './widget';
	import { useWidgetData } from './data.svelte';
	import WidgetCard from './WidgetCard.svelte';
	import DayTable from './DayTable.svelte';

	let { widget, filter, refreshToken, onSettings }: WidgetBodyProps = $props();

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
	{onSettings}
>
	{#if state.data}
		<DayTable points={state.data} label="Sessions" formatValue={formatNumber} />
	{/if}
</WidgetCard>
