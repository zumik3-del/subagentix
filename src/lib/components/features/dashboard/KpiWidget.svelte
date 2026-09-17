<script lang="ts">
	/**
	 * KPI widget body (dashboard Phase 4, task #412; pure renderer from the widget
	 * engine, task #491).
	 *
	 * Content-only: `WidgetShell` owns the fetch and the card chrome, so this
	 * component draws the tiles — windowed cost, token total and session count —
	 * from the typed payload it receives. The stacked mix bar plus its legend
	 * break the token total down by category. Bar geometry uses `linearScale`
	 * from `model/chart.ts` — no chart library, no raw-HTML injection.
	 *
	 * Block-level fitting (task #444): the tiles always render, and the mix bar /
	 * token breakdown are dropped whole when the measured remaining height cannot
	 * hold them, so a short card never shows a half-cut block.
	 */
	import { linearScale } from '$lib/model/chart';
	import { formatCost, formatNumber, tokenBreakdown } from '$lib/model/format';
	import { TOKEN_LABELS, total, usageFromCounts } from '$lib/model/token';
	import type { WidgetRenderProps } from './widget';

	let { data }: WidgetRenderProps<'kpi'> = $props();

	let tokens = $derived(data.tokens);
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

	/** Card body host; measured after mount to decide which blocks fit. */
	let root = $state<HTMLElement | null>(null);
	/** Both blocks render until the first client measurement (SSR-safe). */
	let showMix = $state(true);
	let showBreakdown = $state(true);

	$effect(() => {
		const element = root;
		if (!element) return;
		const tiles = element.querySelector<HTMLElement>('.kpi__tiles');
		const mixBar = element.querySelector<HTMLElement>('.kpi__mix');
		const breakdown = element.querySelector<HTMLElement>('.kpi__breakdown');
		// Natural heights are captured while a block is visible and kept when it
		// is dropped, so hiding a block cannot make it "fit" again in a loop.
		let tilesHeight = 0;
		let mixHeight = 0;
		let breakdownHeight = 0;

		const measure = (): void => {
			const gap = Number.parseFloat(getComputedStyle(element).rowGap) || 0;
			if (tiles && tiles.offsetHeight > 0) tilesHeight = tiles.offsetHeight;
			if (mixBar && mixBar.offsetHeight > 0) mixHeight = mixBar.offsetHeight;
			if (breakdown && breakdown.offsetHeight > 0) breakdownHeight = breakdown.offsetHeight;
			const available = element.clientHeight;
			showMix = available >= tilesHeight + gap + mixHeight;
			showBreakdown = available >= tilesHeight + gap + mixHeight + gap + breakdownHeight;
		};
		measure();

		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	});
</script>

<div class="kpi" bind:this={root}>
	<dl class="kpi__tiles">
		<div class="kpi__tile">
			<dt class="kpi__tile-label">Sessions</dt>
			<dd class="kpi__tile-value">{formatNumber(data.sessions)}</dd>
		</div>
		<div class="kpi__tile">
			<dt class="kpi__tile-label">Cost (gross)</dt>
			<dd class="kpi__tile-value">{formatCost(data.cost)}</dd>
		</div>
		<div class="kpi__tile">
			<dt class="kpi__tile-label">Total tokens</dt>
			<dd class="kpi__tile-value">{formatNumber(tokenTotal)}</dd>
		</div>
	</dl>

	{#if showMix}
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
	{/if}

	{#if showBreakdown}
		<ul class="kpi__breakdown">
			{#each mix as row (row.label)}
				<li class="kpi__breakdown-item">
					<span class="ui-swatch" style={`background:${row.color}`}></span>
					<span class="kpi__breakdown-label">{row.label}</span>
					<span class="kpi__breakdown-value">{formatNumber(row.value)}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	/* Fills the card body so `clientHeight` is the height the blocks share. */
	.kpi {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
		min-height: 0;
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
