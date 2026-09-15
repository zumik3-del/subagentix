<script lang="ts">
	/**
	 * Node identity row (extracted from `NodeDetailPanel`, ADR 2.1).
	 *
	 * Left: agent name + kind/status/model chips + session id. Right: the
	 * wall-clock range and the duration · cost summary. Pure presentation —
	 * no state, no callbacks.
	 */
	import type { Node } from '$lib/model/types';
	import { clock } from '$lib/model/clock.svelte';
	import { formatClock, formatCost, formatDuration } from '$lib/model/format';
	import { displayAgent } from '$lib/model/agent';

	interface Props {
		node: Node;
	}

	let { node }: Props = $props();
</script>

<div class="summary-row identity">
	<div class="identity-left">
		<div class="identity-title">
			<h3>{displayAgent(node.agent)} node</h3>
			<span class="ui-chip">{node.kind}</span>
			<span class="ui-chip">{node.status}</span>
			<span class="ui-chip">{node.modelId ?? 'unknown model'}</span>
		</div>
		<p class="muted mono">{node.sessionId}</p>
	</div>
	<div class="identity-right">
		<span class="identity-time">
			{formatClock(node.startedAt, clock.tz)} →
			{node.endedAt === null ? 'running' : formatClock(node.endedAt, clock.tz)}
		</span>
		<span class="muted" title="Cost (gross)">
			{formatDuration(node.startedAt, node.endedAt)} · {formatCost(node.usage.cost)}
		</span>
	</div>
</div>

<style>
	/* Mirrors the panel's grid-item rule: the row lives in the parent's
	   `.summary-strip` grid, so it needs `min-width: 0` to shrink. */
	.summary-row {
		min-width: 0;
	}

	/* Identity line: name + chips + session on the left, time range and
	   duration · cost stacked on the right. Sits directly above the
	   summary rows in the same block (no divider). */
	.identity {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-1) var(--space-3);
	}

	.identity-left,
	.identity-right {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}

	.identity-right {
		align-items: flex-end;
		gap: var(--space-1);
		text-align: right;
		white-space: nowrap;
		font-size: var(--font-size-small);
		font-variant-numeric: tabular-nums;
		color: var(--text-weak);
	}

	.identity-title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.identity-title h3 {
		margin: 0;
		font-size: var(--font-size-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	/* Matches the Turn header's timing: small, tabular, strong time range. */
	.identity-time {
		color: var(--text-strong);
	}

	.mono {
		font-family: var(--font-family-mono);
		font-size: var(--font-size-sm);
	}
</style>
