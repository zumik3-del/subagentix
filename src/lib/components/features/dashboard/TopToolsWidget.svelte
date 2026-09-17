<script lang="ts">
	/**
	 * Top-tools widget body (dashboard Phase 4, task #413).
	 *
	 * Table-only: `useWidgetData` fetches `/api/dashboard/top-tools` for the
	 * shared filter and `WidgetCard` renders the loading/error/empty states. The
	 * ready payload is rendered as a rank-ordered table — tool, call count and a
	 * dedicated errors column — with no chart or progress bar. Rows are trimmed
	 * to the whole rows the card height can show (`useRowFit` after mount; SSR
	 * shows all rows).
	 *
	 * `getTopTools` caps its `part` scan at `MAX_TOOL_SESSIONS` (the Tier-P
	 * ceiling) and flags `capped`; `period=all` is also the unbounded slow path.
	 * Either case renders the visible note from {@link topToolsNote}.
	 */
	import type { ToolUsage } from '$lib/model/dashboard';
	import type { WidgetBodyProps } from './widget';
	import { useWidgetData } from './data.svelte';
	import { topToolRows, topToolsNote } from './top-tools';
	import WidgetCard from './WidgetCard.svelte';
	import { formatNumber } from '$lib/model/format';
	import { useRowFit } from './fit.svelte';

	let { widget, filter, refreshToken, onSettings }: WidgetBodyProps = $props();

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

	/** Clipped list host; fills the body so its height is the row budget. */
	let list = $state<HTMLElement | null>(null);
	const fit = useRowFit({ container: () => list, total: () => rows.length });
	/** Whole rows that fit; SSR sees every row (no measurement yet). */
	let visible = $derived(rows.slice(0, fit.budget));
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
		<figure class="top-tools" bind:this={list}>
			<table class="top-tools__table">
				<caption class="sr-only">Top tools</caption>
				<thead class="sr-only">
					<tr>
						<th scope="col">Tool</th>
						<th scope="col">Calls</th>
						<th scope="col">Errors</th>
					</tr>
				</thead>
				<tbody>
					{#each visible as row (row.name)}
						<tr>
							<th scope="row" class="top-tools__name" title={row.title}>{row.name}</th>
							<td class="top-tools__count">{formatNumber(row.count)}</td>
							<td class="top-tools__errors">{formatNumber(row.errors)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</figure>
	{/if}
</WidgetCard>

<style>
	.top-tools__note {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--text-weak);
	}

	/* Fills the card body so `clientHeight` is the available row budget; the
	   hard `overflow` clip is a mid-measurement guarantee, not the trimming. */
	.top-tools {
		display: flex;
		flex: 1;
		flex-direction: column;
		margin: 0;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.top-tools__table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--font-size-small);
	}

	.top-tools__table th,
	.top-tools__table td {
		padding: var(--space-1) var(--space-2);
		border-bottom: 1px solid var(--border-weaker-base);
		text-align: left;
		font-weight: var(--font-weight-regular);
		font-variant-numeric: tabular-nums;
		vertical-align: middle;
	}

	.top-tools__table tr:last-child th,
	.top-tools__table tr:last-child td {
		border-bottom: 0;
	}

	.top-tools__name {
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.top-tools__count,
	.top-tools__errors {
		text-align: right;
		white-space: nowrap;
	}

	.top-tools__errors {
		color: var(--text-weak);
	}
</style>
