<script lang="ts">
	/**
	 * SVG shell for the wall-clock Gantt (extracted from `Gantt`, ADR 3.5a).
	 *
	 * Owns the `<svg>` canvas, the single `<defs>` pattern set, the axis header
	 * band (grid + shared time axis) and the per-row backgrounds/hairlines. The
	 * `Gantt` feature root keeps every positioning decision — `x()`,
	 * `rowIndexAtY()`, `chartWidth`/`chartHeight` and `ticks` — and passes the
	 * precomputed slices down: `rows` carries `top`/`active` and `ticks` carries
	 * the mapped x/anchor/label, so this component stays presentation-only.
	 *
	 * Node markup lives in `GanttNodeRow`, edge markup in `GanttEdges`, and the
	 * cursor in the `Gantt` root; all render through the `children` snippet, so
	 * the SVG stays one document with a single `defs` and no duplicate `url(#…)`
	 * pattern ids.
	 */
	import type { Snippet } from 'svelte';
	import type { Node } from '$lib/model/types';

	/**
	 * Minimal per-row slice the background layer renders: a structural subset of
	 * the `Gantt` root's `RowView`, which the root computes in full.
	 */
	interface ChartRow {
		node: Node;
		/** Row top in SVG user units (`AXIS_H + index * ROW_H`). */
		top: number;
		/** Selection-only emphasis (never hover; see the root's `active:` note). */
		active: boolean;
	}

	/**
	 * Precomputed tick slice: the root applies `x()` and `tickAnchor()` and
	 * formats the wall clock, so no positioning math lives here.
	 */
	interface TickView {
		/** Tick instant (ms) — stable `{#each}` key. */
		t: number;
		/** x position in SVG user units. */
		x: number;
		/** Edge-aware `text-anchor`. */
		anchor: 'start' | 'middle' | 'end';
		/** Formatted wall-clock label. */
		label: string;
	}

	interface Props {
		rows: ChartRow[];
		ticks: TickView[];
		chartWidth: number;
		chartHeight: number;
		/** Axis band height in px (`AXIS_H`), shared with the label column. */
		axisHeight: number;
		/** Row height in px (`ROW_H`), shared with the label rows. */
		rowHeight: number;
		/** Horizontal inset of the plot band inside the canvas (`INSET`). */
		inset: number;
		/** Visually emphasised row (hover ?? selection), drives the hover band. */
		hoveredNodeId: string | null;
		onPointerMove: (event: MouseEvent) => void;
		onPointerLeave: () => void;
		onChartClick: (event: MouseEvent) => void;
		/** Node, edge and cursor markup rendered inside the SVG shell. */
		children?: Snippet;
	}

	let {
		rows,
		ticks,
		chartWidth,
		chartHeight,
		axisHeight,
		rowHeight,
		inset,
		hoveredNodeId,
		onPointerMove,
		onPointerLeave,
		onChartClick,
		children
	}: Props = $props();
</script>

<!--
	Pointer-only row hit area (task #229, issue #4): the keyboard path is
	the focusable `g.node` buttons inside, so the SVG click only extends
	the same selection to the empty parts of a chart row.
-->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<svg
	class="chart"
	width={chartWidth}
	height={chartHeight}
	viewBox={`0 0 ${chartWidth} ${chartHeight}`}
	role="img"
	aria-label="Turn wall-clock Gantt"
	onmousemove={onPointerMove}
	onmouseleave={onPointerLeave}
	onclick={onChartClick}
>
	<defs>
		<pattern
			id="removed-hatch"
			width="6"
			height="6"
			patternUnits="userSpaceOnUse"
			patternTransform="rotate(45)"
		>
			<rect class="hatch-removed-bg" width="6" height="6" />
			<line class="hatch-removed-fg" x1="0" y1="0" x2="0" y2="6" stroke-width="2" />
		</pattern>
		<pattern
			id="running-hatch"
			width="6"
			height="6"
			patternUnits="userSpaceOnUse"
			patternTransform="rotate(45)"
		>
			<rect class="hatch-running-bg" width="6" height="6" />
			<line class="hatch-running-fg" x1="0" y1="0" x2="0" y2="6" stroke-width="2" />
		</pattern>
	</defs>

	<!-- Axis header band: a full-width strip behind the time scale, on a
	     slightly distinct token so the scale has its own header without
	     breaking the canvas seam (issue #9). -->
	<rect class="axis-band" x="0" y="0" width={chartWidth} height={axisHeight} />
	<line class="axis-band-border" x1="0" y1={axisHeight} x2={chartWidth} y2={axisHeight} />

	<!-- Row backgrounds + hairlines (issue #8): one uniform canvas, no
	     zebra. Hover/selection come from the state-driven classes; the
	     1px hairline mirrors `.label`'s border-bottom so rows stay aligned
	     across the label/chart seam. -->
	{#each rows as row (row.node.sessionId)}
		<rect
			class="row-bg"
			class:hovered={hoveredNodeId === row.node.sessionId}
			class:active={row.active}
			x="0"
			y={row.top}
			width={chartWidth}
			height={rowHeight}
			pointer-events="none"
		/>
		{#if row.active}
			<rect
				class="row-accent"
				x={chartWidth - 2}
				y={row.top}
				width="2"
				height={rowHeight}
				pointer-events="none"
			/>
		{/if}
	{/each}
	{#each rows as row (row.node.sessionId)}
		<line
			class="row-hairline"
			x1="0"
			y1={row.top + rowHeight}
			x2={chartWidth}
			y2={row.top + rowHeight}
		/>
	{/each}

	<!-- Grid + shared time axis (inset plot band) -->
	{#each ticks as tick (tick.t)}
		<line class="grid-line" x1={tick.x} y1={axisHeight} x2={tick.x} y2={chartHeight} />
		<line class="axis-tick" x1={tick.x} y1={axisHeight - 5} x2={tick.x} y2={axisHeight} />
		<text x={tick.x} y={axisHeight - 10} class="tick" text-anchor={tick.anchor}>
			{tick.label}
		</text>
	{/each}
	<line class="axis-line" x1={inset} y1={axisHeight} x2={chartWidth - inset} y2={axisHeight} />

	{@render children?.()}
</svg>

<style>
	.chart {
		display: block;
		flex: 0 0 auto;
		background: var(--background-strong);
	}

	/*
	 * SVG presentation colors. Static colors live in these classes (tokens);
	 * per-status colors are applied via inline `style` in the markup,
	 * because presentation attributes do not substitute `var()` reliably.
	 */
	/* Axis header band (issue #9): distinct top strip + full-width bottom edge. */
	.axis-band {
		fill: var(--background-stronger);
	}

	.axis-band-border {
		stroke: var(--border-weak-base);
	}

	/* Row hover/selection bands: uniform canvas, no zebra (issue #8). */
	.row-bg {
		fill: transparent;
	}

	.row-bg.hovered {
		fill: var(--surface-interactive-weak);
	}

	.row-bg.active {
		fill: var(--surface-interactive-base);
	}

	.row-accent {
		fill: var(--border-selected);
	}

	/* 1px per-row hairline mirrors `.label`'s border-bottom for row alignment. */
	.row-hairline {
		stroke: var(--border-weaker-base);
		stroke-width: 1;
	}

	.grid-line {
		stroke: var(--border-weaker-base);
	}

	.axis-tick,
	.axis-line {
		stroke: var(--border-weak-base);
	}

	.tick {
		fill: var(--text-weak);
		font-size: var(--font-size-xs);
	}

	.hatch-removed-bg {
		fill: var(--surface-critical-base);
	}

	.hatch-removed-fg {
		stroke: var(--color-danger-strong);
	}

	.hatch-running-bg {
		fill: var(--running-hatch-bg);
	}

	.hatch-running-fg {
		stroke: var(--color-warning-base);
	}
</style>
