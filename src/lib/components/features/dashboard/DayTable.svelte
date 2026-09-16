<script lang="ts">
	/**
	 * Newest-first day table for the per-day dashboard widgets (task #453).
	 *
	 * Presentational only: the series is always real markup — no canvas and no
	 * chart dependency. Rows are the dense UTC-day buckets, newest day first.
	 *
	 * The list is trimmed to the whole rows the card height can show (task
	 * #444): the `figure` fills its body and `useRowFit` measures it after
	 * mount. SSR and the first client paint render every supplied row, so
	 * hydration cannot mismatch.
	 */
	import type { DayBucket } from '$lib/model/chart';
	import { formatNumber } from '$lib/model/format';
	import { useRowFit } from './fit.svelte';

	interface Props {
		/** Dense UTC-day buckets (`{ day: 'YYYY-MM-DD', value }`), ascending. */
		points: readonly DayBucket[];
		/** Series name; used as the a11y table caption and value column header. */
		label: string;
		/** Value formatter for the row cells; defaults to `formatNumber`. */
		formatValue?: (value: number) => string;
	}

	let { points, label, formatValue = formatNumber }: Props = $props();

	/** Newest UTC day first; the input series is ascending. */
	let rows = $derived([...points].reverse());

	/** Clipped list host; fills the body so its height is the row budget. */
	let list = $state<HTMLElement | null>(null);
	const fit = useRowFit({ container: () => list, total: () => rows.length });
	/** Whole rows that fit; SSR sees every row (no measurement yet). */
	let visible = $derived(rows.slice(0, fit.budget));
</script>

{#if rows.length === 0}
	<p class="day-table__empty">No data for this period.</p>
{:else}
	<figure class="day-table" bind:this={list}>
		<table class="day-table__table">
			<caption class="sr-only">{label} per day</caption>
			<thead class="sr-only">
				<tr>
					<th scope="col">Day</th>
					<th scope="col">{label}</th>
				</tr>
			</thead>
			<tbody>
				{#each visible as row (row.day)}
					<tr>
						<th scope="row" class="day-table__day">{row.day}</th>
						<td class="day-table__value">{formatValue(row.value)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</figure>
{/if}

<style>
	/* Fills the card body so `clientHeight` is the available row budget; the
	   hard `overflow` clip is a mid-measurement guarantee, not the trimming. */
	.day-table {
		display: flex;
		flex: 1;
		flex-direction: column;
		margin: 0;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.day-table__table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--font-size-small);
		color: var(--text-base);
	}

	.day-table__table th,
	.day-table__table td {
		padding: var(--space-1) var(--space-2);
		border-bottom: 1px solid var(--border-weak-base);
		text-align: left;
		font-weight: var(--font-weight-regular);
		font-variant-numeric: tabular-nums;
		vertical-align: middle;
	}

	.day-table__day {
		color: var(--text-strong);
		white-space: nowrap;
	}

	.day-table__value {
		text-align: right;
		white-space: nowrap;
	}

	.day-table__empty {
		margin: 0;
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}
</style>
