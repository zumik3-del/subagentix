<script lang="ts">
	/**
	 * Hand-rolled donut chart (dashboard Phase 4, task #412).
	 *
	 * Presentational only: `arcSegments`/`arcPath` from `model/chart.ts` turn the
	 * shares into SVG paths, and the fills come from the `--chart-*` tokens
	 * (spec D1) — no chart library, no raw-HTML injection, no DOM measurement. The plot is
	 * one `role="img"` node with a summary `aria-label`; the visible legend table
	 * below is the non-graphical fallback carrying the value text. The container
	 * scales the `viewBox`, so the donut stays responsive.
	 */
	import { arcPath, arcSegments, topN } from '$lib/model/chart';
	import { formatNumber } from '$lib/model/format';

	/** One input slice before the top-N + "Other" aggregation. */
	interface DonutSlice {
		/** Display label (e.g. agent name). */
		label: string;
		/** Non-negative weight; non-finite/negative values are dropped. */
		value: number;
	}

	interface Props {
		/** Raw slices; cut to the top-N with the remainder merged into "Other". */
		slices: readonly DonutSlice[];
		/** Accessible chart caption, e.g. "Agent distribution". */
		label: string;
		/** Unit shown under the center total, e.g. "sessions". */
		unit?: string;
		/** Value formatter for the center total and the legend; defaults to `formatNumber`. */
		formatValue?: (value: number) => string;
	}

	let { slices, label, unit = '', formatValue = formatNumber }: Props = $props();

	/** Slices kept individually; fewer than this renders every slice as-is. */
	const MAX_SLICES = 6;
	/** Label of the merged remainder arc. */
	const OTHER_LABEL = 'Other';
	/** The `--chart-*` tokens available for slices (spec §2.6). */
	const CHART_TOKENS = 7;

	/** Top-N slices by weight, with the remainder merged into one "Other" arc. */
	let arranged = $derived.by(() => {
		const positive = slices.filter((slice) => Number.isFinite(slice.value) && slice.value > 0);
		if (positive.length <= MAX_SLICES) {
			return topN(positive, positive.length, (slice) => slice.value);
		}
		const head = topN(positive, MAX_SLICES - 1, (slice) => slice.value);
		const shown = new Set(head);
		const other = positive
			.filter((slice) => !shown.has(slice))
			.reduce((sum, slice) => sum + slice.value, 0);
		return [...head, { label: OTHER_LABEL, value: other }];
	});

	/** Total weight of the rendered arcs (0 for an empty/all-zero payload). */
	let total = $derived(arranged.reduce((sum, slice) => sum + slice.value, 0));

	/** Geometry + token color per rendered slice, aligned with `arcSegments`. */
	let arcs = $derived.by(() => {
		const segments = arcSegments(arranged.map((slice) => slice.value));
		return arranged.map((slice, index) => {
			const segment = segments[index];
			return {
				label: slice.label,
				value: slice.value,
				fraction: segment?.fraction ?? 0,
				startAngle: segment?.startAngle ?? 0,
				endAngle: segment?.endAngle ?? 0,
				color: `var(--chart-${(index % CHART_TOKENS) + 1})`
			};
		});
	});

	/** Rounded percent share for the legend and the summary label. */
	function share(fraction: number): string {
		return `${Math.round(fraction * 100)}%`;
	}

	/** Single accessible description of the whole plot. */
	let summary = $derived(
		`${label}: ${formatValue(total)} total. ${arcs
			.map((arc) => `${arc.label} ${formatValue(arc.value)} (${share(arc.fraction)})`)
			.join(', ')}`
	);
</script>

{#if total <= 0}
	<p class="donut__empty">No data for this period.</p>
{:else}
	<figure class="donut">
		<div class="donut__plot">
			<svg
				class="donut__svg"
				viewBox="0 0 100 100"
				role="img"
				aria-label={summary}
			>
				{#each arcs as arc (arc.label)}
					<path
						class="donut__slice"
						d={arcPath(50, 50, 46, 28, arc.startAngle, arc.endAngle)}
						style={`fill:${arc.color}`}
					/>
				{/each}
			</svg>
			<div class="donut__center" aria-hidden="true">
				<span class="donut__total">{formatValue(total)}</span>
				{#if unit}
					<span class="donut__unit">{unit}</span>
				{/if}
			</div>
		</div>

		<table class="donut__legend">
			<caption class="sr-only">{label}</caption>
			<thead class="sr-only">
				<tr>
					<th scope="col">Name</th>
					<th scope="col">Count</th>
					<th scope="col">Share</th>
				</tr>
			</thead>
			<tbody>
				{#each arcs as arc (arc.label)}
					<tr>
						<td class="donut__swatch">
							<span class="ui-swatch" style={`background:${arc.color}`}></span>
						</td>
						<th scope="row" class="donut__label">{arc.label}</th>
						<td class="donut__value">{formatValue(arc.value)}</td>
						<td class="donut__share">{share(arc.fraction)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</figure>
{/if}

<style>
	.donut {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin: 0;
		min-width: 0;
	}

	.donut__plot {
		position: relative;
		width: 100%;
		max-width: 10rem;
		margin: 0 auto;
	}

	.donut__svg {
		display: block;
		width: 100%;
		height: auto;
	}

	/* A hairline of card background separates adjacent slices. */
	.donut__slice {
		stroke: var(--background-strong);
		stroke-width: 1;
	}

	.donut__center {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-1);
		text-align: center;
	}

	.donut__total {
		font-size: var(--font-size-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
		font-variant-numeric: tabular-nums;
	}

	.donut__unit {
		font-size: var(--font-size-xs);
		color: var(--text-weak);
	}

	.donut__legend {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--font-size-small);
	}

	.donut__legend th,
	.donut__legend td {
		padding: var(--space-1) var(--space-2);
		border-bottom: 1px solid var(--border-weaker-base);
		text-align: left;
		font-weight: var(--font-weight-regular);
		vertical-align: middle;
	}

	.donut__legend tr:last-child th,
	.donut__legend tr:last-child td {
		border-bottom: 0;
	}

	.donut__swatch {
		width: var(--space-4);
		padding-right: 0;
	}

	.donut__label {
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.donut__value,
	.donut__share {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.donut__share {
		color: var(--text-weak);
	}

	.donut__empty {
		margin: 0;
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}
</style>
