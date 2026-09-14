<script lang="ts">
	/**
	 * Sticky node-label column of the wall-clock Gantt (extracted from `Gantt`,
	 * ADR 3.4).
	 *
	 * Renders the axis spacer and one `GanttLabelRow` per node. The column is
	 * sticky and reports its measured width through the bindable `labelWidth`
	 * (bound from the DOM `clientWidth`), so the `Gantt` root can fit the chart
	 * into the remaining viewport width; the root owns the width state and the
	 * 0-fallback that hides the single-frame measurement lag.
	 */
	import GanttLabelRow, { type LabelRow } from './GanttLabelRow.svelte';

	interface Props {
		rows: LabelRow[];
		/** Row height in px (`ROW_H`), shared with the SVG rows. */
		rowHeight: number;
		/** Axis band height in px (`AXIS_H`), shared with the SVG axis. */
		axisHeight: number;
		/** Tracker base URL, or null when no tracker UI is configured. */
		refBase: string | null;
		/** Per-node ref-list expander state, keyed by node session id. */
		expandedRefs: Record<string, boolean>;
		/** Measured column width in px; bound from `clientWidth`. */
		labelWidth?: number;
		onSelect: (nodeId: string) => void;
		onHover: (nodeId: string | null) => void;
		onToggleRefs: (key: string) => void;
		onOpenTask: (ref: string) => void;
	}

	let {
		rows,
		rowHeight,
		axisHeight,
		refBase,
		expandedRefs,
		labelWidth = $bindable(0),
		onSelect,
		onHover,
		onToggleRefs,
		onOpenTask
	}: Props = $props();

	/**
	 * Measured column width. The DOM `clientWidth` is bound to this local state
	 * and pushed up to the bindable `labelWidth` so the root can re-fit the
	 * chart; the root's 0-fallback hides the single-frame lag before the first
	 * measurement lands (SSR / first paint).
	 */
	let measuredWidth = $state(0);
	$effect(() => {
		labelWidth = measuredWidth;
	});
</script>

<div
	class="labels"
	bind:clientWidth={measuredWidth}
	style={`--row-h:${rowHeight}px;--axis-h:${axisHeight}px`}
>
	<div class="axis-spacer">Node</div>
	{#each rows as row (row.node.sessionId)}
		<GanttLabelRow
			{row}
			expanded={expandedRefs[row.node.sessionId] ?? false}
			{refBase}
			{onSelect}
			{onHover}
			{onToggleRefs}
			{onOpenTask}
		/>
	{/each}
</div>

<style>
	.labels {
		position: sticky;
		left: 0;
		z-index: 2;
		flex: 0 0 16rem;
		width: 16rem;
		/*
		 * Same canvas as `.chart` (task #229, issue #3): the label column and the
		 * chart share `--background-strong`, so each row reads as one continuous
		 * band with no background seam at the column boundary.
		 */
		background: var(--background-strong);
		/*
		 * Layout-neutral separator: `border-right` would widen the border-box
		 * while `bind:clientWidth` (used for the fitted chart) excludes it,
		 * leaving the chart 1px too wide. A 1px outer shadow draws the same
		 * divider without affecting the measured width.
		 */
		box-shadow: 1px 0 0 var(--border-weak-base);
	}

	.axis-spacer {
		height: var(--axis-h);
		display: flex;
		align-items: flex-end;
		padding: 0 var(--space-2) var(--space-2);
		font-size: var(--font-size-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-weak);
		/* Own header band (issue #9): mirrors the SVG axis band + its bottom
		   border so the seam between label column and chart is invisible. */
		background: var(--background-stronger);
		border-bottom: 1px solid var(--border-weak-base);
	}
</style>
