<script lang="ts">
	/**
	 * Hover time cursor of the wall-clock Gantt (extracted from `Gantt`, ADR 3.5d).
	 *
	 * Renders the vertical cursor line plus its floating clock box and label.
	 * Pure presentation: the `Gantt` root keeps `cursorX`/`cursorT`, the
	 * `cursorLabel` derivation, the pointer handlers and the chart geometry, and
	 * passes the precomputed `cursor` slice down, so this component owns no data
	 * logic.
	 */

	/** Cursor slice: x in SVG user units and the formatted wall-clock label. */
	interface CursorView {
		x: number;
		label: string;
	}

	interface Props {
		/** Active cursor, or null while the pointer is outside the chart band. */
		cursor: CursorView | null;
		/** Chart canvas width in SVG user units (`chartWidth`). */
		chartWidth: number;
		/** Axis band height in px (`AXIS_H`), the line's top anchor. */
		axisHeight: number;
		/** Full chart height, so the cursor line spans every row. */
		chartHeight: number;
	}

	let { cursor, chartWidth, axisHeight, chartHeight }: Props = $props();
</script>

<!-- Hover time cursor -->
{#if cursor}
	<line
		class="cursor-line"
		x1={cursor.x}
		y1={axisHeight}
		x2={cursor.x}
		y2={chartHeight}
		pointer-events="none"
	/>
	<g pointer-events="none">
		<rect
			class="cursor-box"
			x={Math.min(cursor.x + 6, chartWidth - 74)}
			y={axisHeight + 4}
			width="70"
			height="16"
			rx="3"
		/>
		<text
			x={Math.min(cursor.x + 6, chartWidth - 74) + 35}
			y={axisHeight + 15}
			class="cursor-label"
			text-anchor="middle">{cursor.label}</text
		>
	</g>
{/if}

<style>
	.cursor-line {
		stroke: var(--border-selected);
		stroke-width: 1;
	}

	.cursor-box {
		fill: var(--surface-float-base);
		stroke: var(--border-selected);
	}

	.cursor-label {
		fill: var(--text-strong);
		font-size: var(--font-size-xs);
	}
</style>
