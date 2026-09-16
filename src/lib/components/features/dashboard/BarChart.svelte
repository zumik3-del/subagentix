<script lang="ts">
	/**
	 * Hand-rolled horizontal bar chart (dashboard Phase 4, task #412).
	 *
	 * Presentational only: `topN` picks the ranked rows and `linearScale` maps
	 * each value onto a 0–100% bar width from `model/chart.ts` — no chart
	 * library, no raw-HTML injection. Each bar is one inline `role="img"` SVG with a value
	 * `aria-label`; the row's label and numeric value are real text (the
	 * non-graphical fallback). The bar scales with its cell, so the chart is
	 * responsive and the labels stay crisp.
	 *
	 * The list is trimmed to the whole rows the card height can show (task
	 * #444): the figure fills its body and `useRowFit` measures it after mount.
	 * SSR and the first client paint render every supplied row, so hydration
	 * cannot mismatch; the bar scale is computed from the untrimmed rows, so
	 * resizing the card never re-scales the bars.
	 */
	import { linearScale, topN } from '$lib/model/chart';
	import { formatNumber } from '$lib/model/format';
	import { useRowFit } from './fit.svelte';

	/** One ranked bar before truncation. */
	interface BarDatum {
		/** Display label (e.g. a project name). */
		label: string;
		/** Non-negative weight; larger values rank first. */
		value: number;
		/** Optional tooltip, e.g. the full directory path behind a short label. */
		title?: string;
		/**
		 * Optional secondary value text shown under the value and folded into the
		 * `aria-label` (e.g. `12% errors` for a top-tools bar). Absent for charts
		 * whose value is the whole story, so existing callers are unaffected.
		 */
		detail?: string;
	}

	interface Props {
		/** Ranked rows; cut to the top-`limit` by value (stable on ties). */
		bars: readonly BarDatum[];
		/** Accessible caption, e.g. "Top projects". */
		label: string;
		/** Upper bound on ranked rows; defaults to every supplied bar. */
		limit?: number;
		/** Value formatter for the row and its `aria-label`; defaults to `formatNumber`. */
		formatValue?: (value: number) => string;
		/** `--chart-*` token for the bar fill; defaults to `--chart-5`. */
		colorVar?: string;
	}

	let {
		bars,
		label,
		limit = Number.POSITIVE_INFINITY,
		formatValue = formatNumber,
		colorVar = '--chart-5'
	}: Props = $props();

	/** Highest-value rows first, capped at `limit` (all rows by default). */
	let rows = $derived(topN(bars, limit, (bar) => bar.value));

	/** Largest supplied value; a non-positive peak means there is nothing to draw. */
	let peak = $derived(rows.reduce((max, row) => Math.max(max, row.value), 0));

	/** Value → bar width in `[0, 100]`; a zero peak maps every row to `0`. */
	let percent = $derived(linearScale([0, peak], [0, 100]));

	/** Clipped list host; fills the body so its height is the row budget. */
	let list = $state<HTMLElement | null>(null);
	const fit = useRowFit({ container: () => list, total: () => rows.length });
	/** Whole rows that fit; SSR sees every row (no measurement yet). */
	let visible = $derived(rows.slice(0, fit.budget));
</script>

{#if rows.length === 0 || peak <= 0}
	<p class="bar-chart__empty">No data for this period.</p>
{:else}
	<figure class="bar-chart" bind:this={list}>
		<table class="bar-chart__table">
			<caption class="sr-only">{label}</caption>
			<thead class="sr-only">
				<tr>
					<th scope="col">{label}</th>
					<th scope="col">Share</th>
					<th scope="col">Value</th>
				</tr>
			</thead>
			<tbody>
				{#each visible as row}
					<tr>
						<th scope="row" class="bar-chart__label" title={row.title ?? row.label}>
							{row.label}
						</th>
						<td class="bar-chart__bar-cell">
							<svg
								class="bar-chart__bar"
								viewBox="0 0 100 1"
								preserveAspectRatio="none"
								role="img"
								aria-label={`${row.label}: ${formatValue(row.value)}${row.detail ? `, ${row.detail}` : ''}`}
							>
								<rect
									class="bar-chart__fill"
									x="0"
									y="0"
									width={percent(row.value)}
									height="1"
									style={`fill:var(${colorVar})`}
								/>
							</svg>
						</td>
						<td class="bar-chart__value">
							<span class="bar-chart__amount">{formatValue(row.value)}</span>
							{#if row.detail}
								<span class="bar-chart__detail">{row.detail}</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</figure>
{/if}

<style>
	/* Fills the card body so `clientHeight` is the available row budget; the
	   hard `overflow` clip is a mid-measurement guarantee, not the trimming. */
	.bar-chart {
		display: flex;
		flex: 1;
		flex-direction: column;
		margin: 0;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.bar-chart__table {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
		font-size: var(--font-size-small);
	}

	.bar-chart__label,
	.bar-chart__bar-cell,
	.bar-chart__value {
		padding: var(--space-1) var(--space-2);
		vertical-align: middle;
	}

	.bar-chart__label {
		width: 38%;
		text-align: left;
		font-weight: var(--font-weight-regular);
		color: var(--text-strong);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bar-chart__bar-cell {
		width: 47%;
	}

	/* The track is the cell surface; the fill is the value-proportional rect. */
	.bar-chart__bar {
		display: block;
		width: 100%;
		height: var(--space-2);
		background: var(--surface-raised-base);
		border-radius: var(--radius-full);
		overflow: hidden;
	}

	.bar-chart__fill {
		stroke: none;
	}

	.bar-chart__value {
		width: 15%;
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.bar-chart__amount {
		display: block;
	}

	.bar-chart__detail {
		display: block;
		font-size: var(--font-size-xs);
		color: var(--text-weak);
	}

	.bar-chart__empty {
		margin: 0;
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}
</style>
