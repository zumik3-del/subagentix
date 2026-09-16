<script lang="ts">
	/**
	 * Top-projects widget body (dashboard Phase 4, task #412).
	 *
	 * Tier-S horizontal bars: `useWidgetData` fetches `/api/dashboard/top-projects`
	 * for the shared filter and `WidgetCard` renders the loading/error/empty
	 * states. A ready payload is drawn by the hand-rolled `BarChart` (no chart
	 * library); a directory linked to a project shows the project name, else the
	 * last path segment, with the full path kept as the row title.
	 */
	import type { TopDirectoryEntry } from '$lib/model/dashboard';
	import type { WidgetBodyProps } from './widget';
	import { useWidgetData } from './data.svelte';
	import WidgetCard from './WidgetCard.svelte';
	import BarChart from './BarChart.svelte';

	let { widget, filter, refreshToken, onSettings }: WidgetBodyProps = $props();

	const state = useWidgetData<TopDirectoryEntry[]>({
		source: () => widget.source,
		filter: () => filter,
		refreshToken: () => refreshToken
	});

	/** Short display label: the project name when linked, else the path's basename. */
	function projectLabel(entry: TopDirectoryEntry): string {
		const name = entry.projectName?.trim();
		if (name) return name;
		const segments = entry.directory.split('/').filter((segment) => segment !== '');
		return segments.at(-1) ?? entry.directory;
	}

	/** Bar input: ranked rows keyed by directory, with the full path as the tooltip. */
	let bars = $derived(
		(state.data ?? []).map((entry) => ({
			label: projectLabel(entry),
			value: entry.count,
			title: entry.directory
		}))
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
		<BarChart {bars} label="Top projects" colorVar="--chart-1" />
	{/if}
</WidgetCard>
