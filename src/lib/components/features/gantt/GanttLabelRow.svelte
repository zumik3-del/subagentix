<script module lang="ts">
	import type { Node } from '$lib/model/types';
	import type { CollapsedTrackerRefs } from '$lib/model/tracker';

	/**
	 * Minimal per-row view model rendered by the label column: a structural
	 * subset of the `Gantt` root's `RowView`. The root computes the full
	 * view model (row math, flags, tracker refs) and passes the label-relevant
	 * slice down, so this component owns no data logic.
	 */
	export interface LabelRow {
		node: Node;
		/** Agent color for this row (md `color:` or the neutral fallback). */
		agentColor: string;
		/** Selection-only emphasis (never hover; see the root's `active:` note). */
		active: boolean;
		/** Dimmed while another row is hovered/selected. */
		dimmed: boolean;
		/** Node flag chips, already ordered and deduped by the root. */
		flags: Array<{ key: string; label: string; description: string }>;
		/** Inferred tracker refs of this node (deduped). */
		trackerRefs: string[];
		/** Collapsed display view of {@link LabelRow.trackerRefs}. */
		trackerChips: CollapsedTrackerRefs;
	}
</script>

<script lang="ts">
	/**
	 * One row of the sticky Gantt node-label column (extracted from `Gantt`,
	 * ADR 3.4).
	 *
	 * Renders the full-row selection button (agent swatch + name, model, flag
	 * badges) plus the inferred tracker chips pinned to the row's top-right.
	 * Pure presentation: the `GanttLabels` parent owns the tracker-expander
	 * callbacks, and the `Gantt` root owns the selection/hover state and the
	 * measured column width.
	 */
	import { displayAgent } from '$lib/model/agent';
	import TrackerChipList from '$lib/components/composites/TrackerChipList.svelte';

	interface Props {
		row: LabelRow;
		/** Whether this row's tracker-chip list is expanded. */
		expanded: boolean;
		/** Tracker base URL, or null when no tracker UI is configured. */
		refBase: string | null;
		onSelect: (nodeId: string) => void;
		onHover: (nodeId: string | null) => void;
		onToggleRefs: (key: string) => void;
		onOpenTask: (ref: string) => void;
	}

	let { row, expanded, refBase, onSelect, onHover, onToggleRefs, onOpenTask }: Props = $props();

	/** Refs to render for the current collapsed/expanded state. */
	const nodeRefs = $derived(
		expanded
			? [...row.trackerChips.visible, ...row.trackerChips.hidden]
			: row.trackerChips.visible
	);

	/** ui-badge tone for a node flag key (docs/ui-standards.md §6). */
	function flagTone(key: string): 'warning' | 'danger' {
		switch (key) {
			case 'running':
			case 'end=null':
			case 'openStep':
				return 'warning';
			default:
				return 'danger';
		}
	}
</script>

<div class="label" class:active={row.active} class:dimmed={row.dimmed}>
	<button
		type="button"
		class="label-btn"
		aria-pressed={row.active}
		onclick={() => onSelect(row.node.sessionId)}
		onmouseenter={() => onHover(row.node.sessionId)}
		onmouseleave={() => onHover(null)}
		title={`${displayAgent(row.node.agent)} · ${row.node.sessionId} · ${row.node.status}`}
	>
		<span class="who">
			<span class="ui-swatch" style={`background:${row.agentColor}`}></span>
			<span class="agent">{displayAgent(row.node.agent)}</span>
		</span>
		{#if row.node.modelId}
			<span class="model">{row.node.modelId}</span>
		{/if}
		{#if row.flags.length}
			<span class="flags">
				{#each row.flags as flag (flag.key)}
					<span class={`ui-badge ui-badge--${flagTone(flag.key)}`} title={flag.description}>{flag.label}</span>
				{/each}
			</span>
		{/if}
	</button>
	{#if row.trackerRefs.length}
		<span class="refs node-refs">
			<TrackerChipList
				refs={nodeRefs}
				chips={row.trackerChips}
				{expanded}
				onToggle={() => onToggleRefs(row.node.sessionId)}
				onOpen={refBase !== null ? onOpenTask : undefined}
			/>
		</span>
	{/if}
</div>

<style>
	.label {
		display: flex;
		flex-direction: row;
		/*
		 * Node info (agent + model + flags) is pinned to the top-left; the
		 * tracker chips are pinned to the top-right. Stretch keeps the button
		 * filling the full row height (task #229, issue #4) while both children
		 * align their content to the top.
		 */
		align-items: stretch;
		width: 100%;
		height: var(--row-h);
		border-bottom: 1px solid var(--border-weaker-base);
		overflow: hidden;
	}

	/* No zebra (issue #8): hover is a subtle band, selection a stronger one. */
	.label:hover {
		background: var(--surface-interactive-weak);
	}

	.label.active {
		background: var(--surface-interactive-base);
		box-shadow: inset 2px 0 0 var(--border-selected);
	}

	.label.dimmed {
		opacity: 0.5;
	}

	.label-btn {
		display: flex;
		flex-direction: column;
		/* Top-left stack: agent name, then model, then flags. */
		justify-content: flex-start;
		gap: var(--space-1);
		width: 100%;
		/*
		 * Fill the whole row (task #229, issue #4): `flex: 1` stretches the button
		 * over every pixel left after the tracker-chip strip, and dropping the old
		 * negative margin / padding means the hit area reaches the row edges
		 * instead of stopping at the text. The horizontal padding stays on the
		 * button so the text keeps its inline inset.
		 */
		flex: 1;
		min-width: 0;
		padding: var(--space-1) var(--space-2);
		background: none;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--text-strong);
		font: inherit;
		font-size: var(--font-size-small);
		text-align: left;
		cursor: pointer;
	}

	.label-btn:focus-visible {
		outline-offset: -2px;
	}

	.who {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		min-width: 0;
	}

	.agent {
		font-weight: var(--font-weight-medium);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.model {
		color: var(--text-weak);
		font-size: var(--font-size-xs);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.flags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}

	.refs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1);
	}

	.node-refs {
		/* Sibling of the row button, pinned to the top-right: `align-self`
		   overrides `.label`'s stretch so the chip block hugs the row top. */
		flex: 0 0 auto;
		align-self: flex-start;
		padding: var(--space-1) var(--space-2) 0;
	}
</style>
