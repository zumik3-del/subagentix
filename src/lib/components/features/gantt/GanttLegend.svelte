<script lang="ts">
	/**
	 * Swatch legend for the wall-clock Gantt (extracted from `Gantt`, ADR 3.2).
	 *
	 * Pure presentation — no data logic. Renders the Tools ticks
	 * (completed/error/running/other/delegation, permission ring) and the
	 * Markers swatches (compaction diamond, removed chip, running chip). The
	 * `--running-hatch-bg` custom property stays declared on the `.gantt` root
	 * in `Gantt.svelte` and is inherited here, so the legend chip matches the
	 * SVG running hatch exactly.
	 */
</script>

<!-- Legend -->
<div class="legend">
	<div class="legend-group">
		<span class="legend-title">Tools</span>
		<span class="legend-item"><span class="tick tick-completed"></span>completed</span>
		<span class="legend-item"><span class="tick tick-error"></span>error</span>
		<span class="legend-item"><span class="tick tick-running"></span>running</span>
		<span class="legend-item"><span class="tick tick-other"></span>other</span>
		<span class="legend-item"><span class="tick tick-delegation"></span>delegation</span>
		<span class="legend-item"><span class="perm-ring"></span>permission asked</span>
	</div>
	<div class="legend-group">
		<span class="legend-title">Markers</span>
		<span class="legend-item"><span class="diamond"></span>compaction</span>
		<span class="legend-item"><span class="removed-chip"></span>removed (no timestamp)</span>
		<span class="legend-item"><span class="running-chip"></span>running span</span>
	</div>
</div>

<style>
	.legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: var(--space-5);
		margin-top: var(--space-3);
		font-size: var(--font-size-small);
	}

	.legend-group {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.legend-title {
		color: var(--text-weak);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-size: var(--font-size-xs);
		line-height: 1.2;
	}

	.legend-item {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		line-height: 1.2;
		color: var(--text-base);
	}

	.legend .tick {
		display: block;
		width: 4px;
		height: 10px;
		border-radius: 1px;
	}

	.legend .tick-completed {
		background: var(--color-success-base);
	}

	.legend .tick-error {
		background: var(--color-danger-base);
	}

	.legend .tick-running {
		background: var(--color-warning-base);
	}

	.legend .tick-other {
		background: var(--icon-base);
	}

	.legend .tick-delegation {
		width: 7px;
		background: var(--surface-strong);
		border: 1px solid var(--text-strong);
	}

	.perm-ring {
		display: block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		border: 1.5px solid var(--color-warning-base);
	}

	.diamond {
		display: block;
		width: 8px;
		height: 8px;
		background: var(--text-strong);
		transform: rotate(45deg);
	}

	.removed-chip {
		display: block;
		width: 14px;
		height: 9px;
		border-radius: 2px;
		background: repeating-linear-gradient(
			45deg,
			var(--surface-critical-strong),
			var(--surface-critical-strong) 3px,
			var(--color-danger-strong) 3px,
			var(--color-danger-strong) 4px
		);
	}

	.running-chip {
		display: block;
		width: 14px;
		height: 9px;
		border-radius: 2px;
		border: 1px solid var(--color-warning-base);
		background: repeating-linear-gradient(
			45deg,
			var(--running-hatch-bg),
			var(--running-hatch-bg) 3px,
			var(--color-warning-base) 3px,
			var(--color-warning-base) 4px
		);
	}
</style>
