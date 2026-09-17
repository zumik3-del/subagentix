<script lang="ts">
	/**
	 * Top-tools widget body (dashboard Phase 4, task #413; clickable errors
	 * #481; all-calls detail #484).
	 *
	 * Table-only: `useWidgetData` fetches `/api/dashboard/top-tools` for the
	 * shared filter and `WidgetCard` renders the loading/error/empty states. The
	 * ready payload is mapped to rank-ordered rows and rendered by
	 * `TopToolsTable` — the calls/name cells open the in-place "all calls" detail
	 * and the errors cell opens the failures-only detail through
	 * `onOpenToolDetail` (tasks #481/#484).
	 *
	 * `getTopTools` caps its `part` scan at `MAX_TOOL_SESSIONS` (the Tier-P
	 * ceiling) and flags `capped`; `period=all` is also the unbounded slow path.
	 * Either case renders the visible note from {@link topToolsNote}.
	 */
	import type { ToolUsage } from '$lib/model/dashboard';
	import type { WidgetBodyProps } from './widget';
	import { useWidgetData } from './data.svelte';
	import { topToolRows, topToolsNote } from './top-tools';
	import TopToolsTable from './TopToolsTable.svelte';
	import WidgetCard from './WidgetCard.svelte';

	let { widget, filter, refreshToken, onSettings, onOpenToolDetail }: WidgetBodyProps = $props();

	const query = useWidgetData<ToolUsage>({
		source: () => widget.source,
		filter: () => filter,
		refreshToken: () => refreshToken,
		isEmpty: (usage) => usage.tools.length === 0
	});

	/** Rank-ordered rows (count desc, name asc) from the server. */
	let rows = $derived(query.data ? topToolRows(query.data) : []);

	/** Capped/all-period explanation, or `null` when the counts are exact. */
	let note = $derived(query.data ? topToolsNote(query.data, filter.period) : null);
</script>

<WidgetCard
	title={widget.title}
	status={query.status}
	error={query.error ?? undefined}
	refreshing={query.refreshing}
	onRefresh={query.refresh}
	{onSettings}
>
	{#if query.data}
		{#if note}
			<p class="top-tools__note">{note}</p>
		{/if}
		<TopToolsTable {rows} {onOpenToolDetail} />
	{/if}
</WidgetCard>

<style>
	.top-tools__note {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--text-weak);
	}
</style>
