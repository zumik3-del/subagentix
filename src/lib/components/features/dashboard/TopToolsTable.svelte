<script lang="ts">
	/**
	 * Top-tools table (dashboard Phase 4, task #413; clickable errors #481).
	 *
	 * Presentation-only: the parent maps the Tier-P payload to {@link TopToolRow}
	 * and this component renders the rank-ordered table. Rows are trimmed to the
	 * whole rows the card height can show (`useRowFit` after mount; SSR shows all
	 * rows). The errors cell is a button only when the tool actually errored and
	 * an opener is supplied; a zero-error row stays inert text, so the control
	 * never promises a detail view that has no rows.
	 */
	import { formatNumber } from '$lib/model/format';
	import type { TopToolRow } from './top-tools';
	import { useRowFit } from './fit.svelte';

	interface Props {
		/** Rank-ordered rows (count desc, name asc) from the server. */
		rows: readonly TopToolRow[];
		/** Opens the error detail for one tool; absent => the cell is inert. */
		onOpenToolErrors?: (tool: string) => void;
	}

	let { rows, onOpenToolErrors }: Props = $props();

	/** Clipped list host; fills the body so its height is the row budget. */
	let list = $state<HTMLElement | null>(null);
	const fit = useRowFit({ container: () => list, total: () => rows.length });
	/** Whole rows that fit; SSR sees every row (no measurement yet). */
	let visible = $derived(rows.slice(0, fit.budget));
</script>

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
					<td class="top-tools__errors">
						{#if row.errors > 0 && onOpenToolErrors}
							<button
								type="button"
								class="top-tools__errors-btn"
								title={row.title}
								aria-label={`View ${formatNumber(row.errors)} failed calls for ${row.name}`}
								onclick={() => onOpenToolErrors(row.name)}
							>
								{formatNumber(row.errors)}
							</button>
						{:else}
							<span title={row.title}>{formatNumber(row.errors)}</span>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</figure>

<style>
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

	/* The errored count reads as an actionable link-like control while keeping
	   the cell's right alignment; the global focus ring supplies its own outline. */
	.top-tools__errors-btn {
		margin: 0;
		padding: 0;
		background: none;
		border: 0;
		border-radius: var(--radius-xs);
		color: var(--color-danger-strong);
		font: inherit;
		font-variant-numeric: tabular-nums;
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}

	.top-tools__errors-btn:hover {
		color: var(--color-danger-base);
	}
</style>
