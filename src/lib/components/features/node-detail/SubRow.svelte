<script lang="ts">
	/**
	 * One non-step table row (extracted from `NodeDetailPanel`, ADR 2.6).
	 *
	 * Two variants, selected by `nested`:
	 * - `nested` — a step child (`<tr class="child-row …">`) rendered under its
	 *   parent `StepRow`; `open` drives the collapsed CSS (children stay in the
	 *   DOM so their anchors resolve, hidden via `.row-collapsed`).
	 * - top-level — a marker row (`<tr class="marker-row …">`): start/prompt or
	 *   an orphan tool/action; the whole row jumps to the detail card.
	 *
	 * Pure presentation — the panel root owns the jump logic and passes
	 * `onFocusCall` / `onFocusAction` down, keeping `tool-call-<id>` /
	 * `action-<id>` scroll targets resolving.
	 */
	import type { NodeRow } from '$lib/model/node';
	import { clock } from '$lib/model/clock.svelte';
	import { formatClock, formatDuration } from '$lib/model/format';
	import { displayAgent } from '$lib/model/agent';

	interface Props {
		row: NodeRow;
		/** `true` inside a step (child row); `false` for a top-level marker row. */
		nested: boolean;
		/** Parent step expansion (child rows only); markers ignore it. */
		open?: boolean;
		usageColumns: string[];
		/** Jump to a tool-call detail block (owned by the panel root). */
		onFocusCall: (event: MouseEvent, id: string) => void;
		/** Jump to an action detail block (owned by the panel root). */
		onFocusAction: (event: MouseEvent, id: string | null) => void;
	}

	let { row, nested, open = true, usageColumns, onFocusCall, onFocusAction }: Props = $props();

	/** Status → dot tone (mirrors the panel's table mapping). */
	function statusTone(status: string): string {
		switch (status.toLowerCase()) {
			case 'completed':
			case 'complete':
			case 'success':
				return 'ok';
			case 'error':
			case 'failed':
				return 'err';
			case 'running':
			case 'pending':
				return 'run';
			default:
				return 'other';
		}
	}
</script>

{#if nested}
	<tr class={`child-row child-${row.kind}`} class:row-collapsed={!open}>
		<td class="child-mark col-num" aria-hidden="true">↳</td>
		<td class="col-event">
			<span class="cell-flex">
				{#if row.kind === 'tool' && row.call}
					{@const call = row.call}
					<span class="row-icon">
						<span class={`dot dot-${statusTone(call.status)}`}></span>
					</span>
					<button
						type="button"
						class="ui-link-btn reason-link"
						title={`${call.name} · ${call.status}`}
						aria-label={`Jump to ${call.name} call`}
						onclick={(event) => onFocusCall(event, call.id)}
					>
						{call.name}
					</button>
					{#if call.isMcp}<span class="ui-badge ui-badge--mcp">MCP</span>{/if}
					{#if call.isDelegation}<span class="ui-badge ui-badge--deleg">delegation</span>{/if}
					{#if call.permission}
						<span class="ui-badge ui-badge--perm"
							>ask{call.permission.reply ? `: ${call.permission.reply}` : ''}</span
						>
					{/if}
					<span class="muted">{call.status}</span>
				{:else}
					<span class="row-icon">
						<span class={`dot dot-kind-${row.kind}`}></span>
					</span>
					<button
						type="button"
						class="ui-link-btn action-link"
						title={`Jump to ${row.kind} details`}
						onclick={(event) => onFocusAction(event, row.actionId)}
					>
						{row.label && row.label !== row.kind ? row.label : row.kind}
					</button>
				{/if}
			</span>
		</td>
		<td class="mono col-time">{formatClock(row.at, clock.tz)}</td>
		<td class="mono col-time">
			{row.endedAt === null ? '—' : formatClock(row.endedAt, clock.tz)}
		</td>
		<td class="col-time">
			{row.endedAt === null ? '—' : formatDuration(row.at, row.endedAt)}
		</td>
		{#each usageColumns as label (label)}
			<td class="num col-token">—</td>
		{/each}
		<td class="num col-cost">—</td>
	</tr>
{:else}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
	<tr
		class={`marker-row marker-${row.kind}`}
		onclick={(event) => onFocusAction(event, row.actionId)}
	>
		<td class="marker-mark col-num" aria-hidden="true">
			{row.kind === 'start' ? '▶' : row.kind === 'prompt' ? '▸' : '·'}
		</td>
		<td class="col-event">
			<span class="cell-flex">
				{#if row.kind === 'start'}
					<span class="row-icon">
						<span class="dot dot-kind-start"></span>
					</span>
					<span>{displayAgent(row.label)}</span>
					{#if row.summary}<span class="muted">{row.summary}</span>{/if}
				{:else if row.kind === 'prompt'}
					<span class="row-icon">
						<span class="dot dot-kind-prompt"></span>
					</span>
					<span>prompt</span>
				{:else if row.kind === 'tool' && row.call}
					{@const call = row.call}
					<span class="row-icon">
						<span class={`dot dot-${statusTone(call.status)}`}></span>
					</span>
					<button
						type="button"
						class="ui-link-btn reason-link"
						title={`${call.name} · ${call.status}`}
						aria-label={`Jump to ${call.name} call`}
						onclick={(event) => onFocusCall(event, call.id)}
					>
						{call.name}
					</button>
					{#if call.isMcp}<span class="ui-badge ui-badge--mcp">MCP</span>{/if}
					{#if call.isDelegation}<span class="ui-badge ui-badge--deleg">delegation</span>{/if}
				{:else}
					<span class="row-icon">
						<span class={`dot dot-kind-${row.kind}`}></span>
					</span>
					<button
						type="button"
						class="ui-link-btn action-link"
						title={`Jump to ${row.kind} details`}
						onclick={(event) => onFocusAction(event, row.actionId)}
					>
						{row.label && row.label !== row.kind ? row.label : row.kind}
					</button>
				{/if}
			</span>
		</td>
		<td class="mono col-time">{formatClock(row.at, clock.tz)}</td>
		<td class="mono col-time">{row.endedAt === null ? '—' : formatClock(row.endedAt, clock.tz)}</td>
		<td class="col-time">{row.endedAt === null ? '—' : formatDuration(row.at, row.endedAt)}</td>
		{#each usageColumns as label (label)}
			<td class="num col-token">—</td>
		{/each}
		<td class="num col-cost">—</td>
	</tr>
{/if}

<style>
	/* `td`/column/`.dot` chrome moved verbatim from the panel; `th` chrome stays
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

	.child-row.row-collapsed {
		display: none;
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

	.child-mark,
	.marker-mark {
		color: var(--text-weak);
	}

	.marker-row {
		color: var(--text-weak);
	}

	.marker-row .ui-badge {
		font-size: var(--font-size-xs);
	}

	.dot {
		display: inline-block;
		width: 0.55rem;
		height: 0.55rem;
		border-radius: var(--radius-full);
		flex: 0 0 auto;
		vertical-align: middle;
	}

	/* Muted fills mirroring the Details badge palette (the -strong tone)
	   instead of the bright -base accents. */
	.dot-ok {
		background: var(--color-success-strong);
	}
	.dot-err {
		background: var(--color-danger-strong);
	}
	.dot-run {
		background: var(--color-warning-strong);
	}
	.dot-other {
		background: var(--icon-base);
	}

	/* Action-kind dots, mirroring the Details badge palette. */
	.dot-kind-text,
	.dot-kind-file,
	.dot-kind-prompt {
		background: var(--color-accent-strong);
	}
	.dot-kind-reasoning,
	.dot-kind-agent {
		background: var(--color-info-strong);
	}
	.dot-kind-patch {
		background: var(--color-success-strong);
	}
	.dot-kind-compaction {
		background: var(--text-weak);
	}
	.dot-kind-start {
		background: var(--icon-base);
	}
</style>
