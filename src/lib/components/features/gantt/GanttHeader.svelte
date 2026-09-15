<script lang="ts">
	/**
	 * Turn header for the wall-clock Gantt (extracted from `Gantt`, ADR 3.1).
	 *
	 * Renders the turn label with the shortened root-session id, the turn's
	 * token breakdown plus gross cost, and the wall-clock time range/duration.
	 * Pure presentation: the turn totals are derived in the `Gantt` root and
	 * passed down, so this component owns no data logic.
	 */
	import type { Usage } from '$lib/model/types';
	import type { TurnExtent } from '$lib/model/gantt';
	import { clock } from '$lib/model/clock.svelte';
	import {
		formatClock,
		formatCost,
		formatDuration,
		formatNumber,
		tokenBreakdown
	} from '$lib/model/format';
	import { nodeShortId } from '$lib/model/gantt';

	interface Props {
		/** 1-based turn order within the session; `null` renders an em dash. */
		turnIndex: number | null;
		/** Root session id of the turn, shortened for the label. */
		rootSessionId: string;
		/** Aggregate usage over the turn's nodes. */
		usage: Usage;
		/** Axis domain of the turn (start/end wall-clock ms). */
		extent: TurnExtent;
	}

	let { turnIndex, rootSessionId, usage, extent }: Props = $props();
</script>

<header class="head">
	<div class="head-main">
		<p class="turn-title">
			Turn {turnIndex ?? '—'}
			<span class="turn-sid">({nodeShortId(rootSessionId)})</span>
		</p>
		<ul class="tokens">
			{#each tokenBreakdown(usage) as token (token.label)}
				<li><span class="muted">{token.label}</span> {formatNumber(token.value)}</li>
			{/each}
			<li class="cost" title="Cost (gross)">{formatCost(usage.cost)}</li>
		</ul>
	</div>
	<div class="timing">
		<span class="time-range">
			{formatClock(extent.start, clock.tz)} → {formatClock(extent.end, clock.tz)}
		</span>
		<span class="duration">{formatDuration(extent.start, extent.end)}</span>
	</div>
</header>

<style>
	/* Same card surface as the session header (docs/ui-standards.md). */
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--space-2) var(--space-4);
		flex-wrap: wrap;
		background: var(--background-strong);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-lg);
		padding: var(--space-4);
		margin-bottom: var(--space-4);
	}

	.head-main {
		min-width: 0;
	}

	.turn-title {
		margin: 0;
		font-size: var(--font-size-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.turn-sid {
		color: var(--text-weak);
		font-weight: normal;
	}

	.tokens {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		list-style: none;
		margin: var(--space-1) 0 0;
		padding: 0;
		font-size: var(--font-size-small);
	}

	.tokens li {
		font-variant-numeric: tabular-nums;
	}

	.tokens .cost {
		color: var(--text-strong);
	}

	/* Time block: pinned to the header's top-right and stacked (docs/ui-standards.md). */
	.timing {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		flex: 0 0 auto;
		gap: var(--space-1);
		text-align: right;
		white-space: nowrap;
		font-size: var(--font-size-small);
		font-variant-numeric: tabular-nums;
		color: var(--text-weak);
	}

	.timing .time-range {
		color: var(--text-strong);
	}
</style>
