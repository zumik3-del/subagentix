<script lang="ts">
	/**
	 * KPI widget body (dashboard Phase 4, task #412).
	 *
	 * Tier-S/M stats: `useWidgetData` fetches `/api/dashboard/kpi` for the shared
	 * filter and `WidgetCard` renders the loading/error/empty states. The tiles
	 * show the windowed cost, token total and session count; the stacked mix bar
	 * plus its legend break the token total down by category. Bar geometry uses
	 * `linearScale` from `model/chart.ts` — no chart library, no raw-HTML injection.
	 */
	import { linearScale } from '$lib/model/chart';
	import { formatCost, formatNumber, tokenBreakdown } from '$lib/model/format';
	import { TOKEN_LABELS, total, usageFromCounts, type TokenCounts } from '$lib/model/token';
	import type { WidgetBodyProps } from './widget';
	import { useWidgetData } from './data.svelte';
	import WidgetCard from './WidgetCard.svelte';

	/** `/api/dashboard/kpi` payload (see `routes/api/dashboard/widgets.ts`). */
	interface KpiData {
		/** In-window/scope sessions (Tier S). */
		sessions: number;
		/** Summed `message.data.cost` (Tier M). */
		cost: number;
		/** Summed `message.data.tokens.*` (Tier M). */
		tokens: TokenCounts;
	}

	/** Zeroed fallback so the derived view is valid before the payload lands. */
	const EMPTY_TOKENS: TokenCounts = {
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0
	};

	let { widget, filter, refreshToken }: WidgetBodyProps = $props();

	const state = useWidgetData<KpiData>({
		source: () => widget.source,
		filter: () => filter,
		refreshToken: () => refreshToken
	});

	let tokens = $derived(state.data?.tokens ?? EMPTY_TOKENS);
	let tokenTotal = $derived(total(tokens));

	/**
	 * The five token categories in the shared order, each carrying its
	 * `--chart-*` color, its share of the total as a 0–100 bar width, and the
	 * running offset for the stacked mix bar.
	 */
	let mix = $derived.by(() => {
		const rows = tokenBreakdown(usageFromCounts(tokens)).filter(
			(row) => row.label !== TOKEN_LABELS.total
		);
		const scale = linearScale([0, tokenTotal], [0, 100]);
		let offset = 0;
		return rows.map((row, index) => {
			const width = scale(row.value);
			const x = offset;
			offset += width;
			return {
				label: row.label,
				value: row.value,
				color: `var(--chart-${index + 1})`,
				width,
				x
			};
		});
	});

	/** Accessible description of the token mix bar. */
	let mixLabel = $derived(
		`Token mix: ${mix
			.map((row) => `${row.label} ${tokenTotal > 0 ? Math.round((row.value / tokenTotal) * 100) : 0}%`)
			.join(', ')}`
	);
</script>

<WidgetCard
	title={widget.title}
	status={state.status}
	error={state.error ?? undefined}
	refreshing={state.refreshing}
	onRefresh={state.refresh}
>
	<div class="kpi">
		<dl class="kpi__tiles">
			<div class="kpi__tile">
				<dt class="kpi__tile-label">Sessions</dt>
				<dd class="kpi__tile-value">{formatNumber(state.data?.sessions ?? 0)}</dd>
			</div>
			<div class="kpi__tile">
				<dt class="kpi__tile-label">Cost (gross)</dt>
				<dd class="kpi__tile-value">{formatCost(state.data?.cost ?? 0)}</dd>
			</div>
			<div class="kpi__tile">
				<dt class="kpi__tile-label">Total tokens</dt>
				<dd class="kpi__tile-value">{formatNumber(tokenTotal)}</dd>
			</div>
		</dl>

		<div class="kpi__mix">
			<svg
				class="kpi__mix-svg"
				viewBox="0 0 100 1"
				preserveAspectRatio="none"
				role="img"
				aria-label={mixLabel}
			>
				{#each mix as row (row.label)}
					<rect
						class="kpi__mix-seg"
						x={row.x}
						y="0"
						width={row.width}
						height="1"
						style={`fill:${row.color}`}
					/>
				{/each}
			</svg>
		</div>

		<ul class="kpi__breakdown">
			{#each mix as row (row.label)}
				<li class="kpi__breakdown-item">
					<span class="ui-swatch" style={`background:${row.color}`}></span>
					<span class="kpi__breakdown-label">{row.label}</span>
					<span class="kpi__breakdown-value">{formatNumber(row.value)}</span>
				</li>
			{/each}
		</ul>
	</div>
</WidgetCard>

<style>
	.kpi {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}

	.kpi__tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--space-3);
		margin: 0;
	}

	.kpi__tile {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-3);
		background: var(--surface-base);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-md);
		min-width: 0;
	}

	.kpi__tile-label {
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.kpi__tile-value {
		margin: 0;
		font-size: var(--font-size-x-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
		font-variant-numeric: tabular-nums;
	}

	/* Stacked token-mix bar: the container is the track, the SVG the segments. */
	.kpi__mix {
		height: var(--space-2);
		background: var(--surface-raised-base);
		border-radius: var(--radius-full);
		overflow: hidden;
	}

	.kpi__mix-svg {
		display: block;
		width: 100%;
		height: 100%;
	}

	.kpi__mix-seg {
		stroke: none;
	}

	.kpi__breakdown {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--font-size-small);
	}

	.kpi__breakdown-item {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	.kpi__breakdown-label {
		color: var(--text-weak);
		white-space: nowrap;
	}

	.kpi__breakdown-value {
		color: var(--text-strong);
		font-variant-numeric: tabular-nums;
	}
</style>
