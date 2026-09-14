<script lang="ts">
	/**
	 * One step row of the Steps & actions table (extracted from
	 * `NodeDetailPanel`, ADR 2.6).
	 *
	 * Renders the numbered step `<tr>` plus its child rows (each a `SubRow`).
	 * Pure presentation — the panel root owns the `expanded` state and passes
	 * the resolved `open` flag plus the `onToggle` / `onFocus*` callbacks down.
	 */
	import type { NodeRow, StepToolSummary } from '$lib/model/node';
	import { summarizeStepTools } from '$lib/model/node';
	import type { Step } from '$lib/model/types';
	import { formatClock, formatCost, formatDuration, formatNumber, tokenBreakdown } from '$lib/model/format';
	import TreeIcon from '$lib/components/primitives/TreeIcon.svelte';
	import SubRow from './SubRow.svelte';

	interface Props {
		row: NodeRow;
		/**
		 * The step's *visible* child rows (the filtered set from the root); the
		 * Reason summary must reflect what is on screen. Named `childRows`
		 * because `children` is Svelte's reserved snippet prop.
		 */
		childRows: NodeRow[];
		/** Whether this step is expanded (resolved by the panel root's `isOpen`). */
		open: boolean;
		usageColumns: string[];
		/** Toggle this step's expansion (owned by the panel root). */
		onToggle: (key: string) => void;
		onFocusCall: (event: MouseEvent, id: string) => void;
		onFocusAction: (event: MouseEvent, id: string | null) => void;
	}

	let { row, childRows, open, usageColumns, onToggle, onFocusCall, onFocusAction }: Props = $props();

	/** Accessible description of a step's tools (raw reason kept as a tooltip). */
	function reasonTitle(stepNo: number, step: Step, summary: StepToolSummary): string {
		const errors = summary.errorCount > 0 ? ` · ${summary.errorCount} failed` : '';
		const raw = step.reason ? ` — ${step.reason}` : '';
		const plural = summary.count === 1 ? '' : 's';
		return `Step ${stepNo + 1}: ${summary.label} (${summary.count} tool call${plural})${errors}${raw}`;
	}
</script>

{#if row.kind === 'step' && row.step && row.stepIndex !== null}
	{@const step = row.step}
	{@const summary = summarizeStepTools(
		childRows.filter((child) => child.kind === 'tool').map((child) => child.call!)
	)}
	{@const cells = tokenBreakdown(step.usage)}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
	<tr class="step-row" onclick={() => onToggle(row.key)}>
		<td class="col-num">{row.stepIndex + 1}</td>
		<td class="col-event">
			<span class="cell-flex">
				<span class="row-icon">
					<button
						type="button"
						class="ui-icon-btn row-toggle"
						aria-expanded={open}
						aria-label={open ? 'Collapse step' : 'Expand step'}
						onclick={(event) => {
							event.stopPropagation();
							onToggle(row.key);
						}}
					>
						<TreeIcon name="chevron" expanded={open} size={14} />
					</button>
				</span>
				<span class="step-reason" title={reasonTitle(row.stepIndex, step, summary)}>
					{step.reason ?? 'step'}
				</span>
				{#if step.open}
					<span class="ui-badge">open</span>
				{/if}
				{#if summary.count > 0}
					<span class="muted">{summary.count} tool{summary.count === 1 ? '' : 's'}</span>
				{/if}
				{#if summary.errorCount > 0}
					<span class="reason-err">· {summary.errorCount} err</span>
				{/if}
			</span>
		</td>
		<td class="mono col-time">{formatClock(step.startedAt)}</td>
		<td class="mono col-time">
			{step.endedAt === null ? 'running' : formatClock(step.endedAt)}
		</td>
		<td class="col-time">{formatDuration(step.startedAt, step.endedAt)}</td>
		{#each cells as cell (cell.label)}
			<td class="num col-token">{formatNumber(cell.value)}</td>
		{/each}
		<td class="num col-cost">{formatCost(step.usage.cost)}</td>
	</tr>
	{#each childRows as child (child.key)}
		<SubRow row={child} nested open={open} {usageColumns} {onFocusCall} {onFocusAction} />
	{/each}
{/if}

<style>
	/* `td`/column/step chrome moved verbatim from the panel; `th` chrome stays
	   in `NodeActionsTable` where the header lives. Selectors are split because
	   Svelte scopes styles per component. */
	td {
		padding: var(--space-1) var(--space-2);
		border-bottom: 1px solid var(--border-weaker-base);
		text-align: left;
		vertical-align: middle;
	}

	.mono {
		font-family: var(--font-family-mono);
		font-size: var(--font-size-sm);
	}

	/* Fixed column widths so expanding a step never shifts the layout. */
	.col-num {
		width: 2rem;
		padding-left: var(--space-1);
		padding-right: var(--space-1);
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.col-event {
		width: 20rem;
		padding-left: var(--space-1);
	}

	.col-time {
		width: 6.5rem;
	}

	.col-token {
		width: 6rem;
	}

	.col-cost {
		width: 6rem;
	}

	/* Pin the first two columns while the token columns scroll horizontally. */
	.col-num,
	.col-event {
		position: sticky;
		z-index: 2;
		background: var(--background-strong);
	}

	.col-num {
		left: 0;
	}

	.col-event {
		left: 2rem;
		overflow: hidden;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.reason-err {
		margin-left: var(--space-1);
		color: var(--color-danger-strong);
	}

	.step-row {
		cursor: pointer;
	}

	.step-row:hover {
		background: var(--surface-raised-base-hover);
	}

	.step-row:hover .col-num,
	.step-row:hover .col-event {
		background: var(--surface-raised-base-hover);
	}

	/* Inner flex wrapper: keeps the <td> a real table-cell (so its bottom
	   border spans the column) while aligning the row's contents. */
	.cell-flex {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	/* Uniform leading-icon slot so the expand chevron and the child dots
	   share one column and every label starts at the same x. */
	.row-icon {
		flex: 0 0 var(--space-6);
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	/* The chevron is a control, not a button-shaped target: no own hover fill. */
	.row-toggle:hover:not(:disabled) {
		background: transparent;
	}

	.row-toggle {
		vertical-align: middle;
	}
</style>
