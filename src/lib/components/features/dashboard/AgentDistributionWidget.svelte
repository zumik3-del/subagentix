<script lang="ts">
	/**
	 * Agent-distribution widget body (dashboard Phase 4, task #412; pure renderer
	 * from the widget engine, task #491).
	 *
	 * Content-only: `WidgetShell` owns the fetch and the card chrome, so this
	 * component renders the ready payload as a rank-ordered table (agent, count
	 * and share) — no chart library, no SVG. Rows are trimmed to the whole rows
	 * the card height can show (`useRowFit` after mount; SSR shows all rows).
	 *
	 * It stays a separate body from `top-projects` (task #491): that widget draws
	 * inline-SVG bars (`BarChart`) rather than a table, so the two share no
	 * markup — only the `figure`/`useRowFit` scaffolding already factored into
	 * those primitives. A forced merge would need a per-cell view-kind switch,
	 * which the widget engine deliberately avoids.
	 */
	import type { WidgetRenderProps } from './widget';
	import { formatNumber } from '$lib/model/format';
	import { useRowFit } from './fit.svelte';

	let { data }: WidgetRenderProps<'agent-distribution'> = $props();

	/** The `--chart-*` tokens available for the row swatches (spec §2.6). */
	const CHART_TOKENS = 7;

	/** Rank-ordered rows from the API (count desc, then name asc). */
	let rows = $derived(data);

	/** Total sessions across the rows; the share denominator. */
	let total = $derived(rows.reduce((sum, row) => sum + row.count, 0));

	/** Clipped list host; fills the body so its height is the row budget. */
	let list = $state<HTMLElement | null>(null);
	const fit = useRowFit({ container: () => list, total: () => rows.length });
	/** Whole rows that fit; SSR sees every row (no measurement yet). */
	let visible = $derived(rows.slice(0, fit.budget));

	/** Rounded percent share of the total for one row. */
	function share(count: number): string {
		return total > 0 ? `${Math.round((count / total) * 100)}%` : '0%';
	}
</script>

{#if rows.length === 0}
	<p class="distribution__empty">No data for this period.</p>
{:else}
	<figure class="distribution" bind:this={list}>
		<table class="distribution__table">
			<caption class="sr-only">Agent distribution</caption>
			<thead class="sr-only">
				<tr>
					<th scope="col">Name</th>
					<th scope="col">Sessions</th>
					<th scope="col">Share</th>
				</tr>
			</thead>
			<tbody>
				{#each visible as row, index (row.name)}
					<tr>
						<td class="distribution__swatch">
							<span
								class="ui-swatch"
								style={`background:var(--chart-${(index % CHART_TOKENS) + 1})`}
							></span>
						</td>
						<th scope="row" class="distribution__name">{row.name}</th>
						<td class="distribution__count">{formatNumber(row.count)}</td>
						<td class="distribution__share">{share(row.count)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</figure>
{/if}

<style>
	/* Fills the card body so `clientHeight` is the available row budget; the
	   hard `overflow` clip is a mid-measurement guarantee, not the trimming. */
	.distribution {
		display: flex;
		flex: 1;
		flex-direction: column;
		margin: 0;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.distribution__table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--font-size-small);
	}

	.distribution__table th,
	.distribution__table td {
		padding: var(--space-1) var(--space-2);
		border-bottom: 1px solid var(--border-weaker-base);
		text-align: left;
		font-weight: var(--font-weight-regular);
		font-variant-numeric: tabular-nums;
		vertical-align: middle;
	}

	.distribution__table tr:last-child th,
	.distribution__table tr:last-child td {
		border-bottom: 0;
	}

	.distribution__swatch {
		width: var(--space-4);
		padding-right: 0;
	}

	.distribution__name {
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.distribution__count,
	.distribution__share {
		text-align: right;
		white-space: nowrap;
	}

	.distribution__share {
		color: var(--text-weak);
	}

	.distribution__empty {
		margin: 0;
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}
</style>
