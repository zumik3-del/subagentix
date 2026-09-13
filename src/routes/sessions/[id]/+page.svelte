<script lang="ts">
	import type { PageProps } from './$types';
	import Gantt from '$lib/components/Gantt.svelte';
	import {
		formatClock,
		formatCost,
		formatDate,
		formatDuration,
		formatNumber,
		tokenBreakdown
	} from '$lib/model/format';

	let { data }: PageProps = $props();
</script>

<main>
	<header>
		<div class="head-main">
			<h1>{data.session.title || data.session.id}</h1>
			<div class="meta">
				<span class="ui-chip">{data.session.agent}</span>
				<span class="dir" title={data.session.directory}>{data.session.directory}</span>
				<span class="child-count">
					{data.session.childCount} child session{data.session.childCount === 1 ? '' : 's'}
				</span>
				<span class="cost" title="Cost (gross)">{formatCost(data.session.usage.cost)}</span>
			</div>
			<ul class="tokens">
				{#each tokenBreakdown(data.session.usage) as token (token.label)}
					<li><span class="muted">{token.label}</span> {formatNumber(token.value)}</li>
				{/each}
			</ul>
		</div>
		<div class="timing">
			<span class="time-range">
				{formatClock(data.session.createdAt)} → {formatClock(data.session.updatedAt)}
			</span>
			<span class="date">
				{#if formatDate(data.session.createdAt) === formatDate(data.session.updatedAt)}
					{formatDate(data.session.createdAt)}
				{:else}
					{formatDate(data.session.createdAt)} → {formatDate(data.session.updatedAt)}
				{/if}
			</span>
			<span class="duration">
				{formatDuration(data.session.createdAt, data.session.updatedAt)}
			</span>
		</div>
	</header>

	{#if data.gantt}
		<section class="selected">
			<Gantt
				model={data.gantt}
				turnIndex={data.turns.find((turn) => turn.turnId === data.gantt?.turnId)?.index ?? null}
				ziptaskEnabled={data.ziptaskEnabled}
				ziptaskBaseUrl={data.ziptaskBaseUrl}
				agentColors={data.agentColors}
			/>
		</section>
	{:else}
		<p class="empty">Select a turn in the session tree to view its Gantt.</p>
	{/if}
</main>

<style>
	main {
		width: 100%;
		padding: var(--space-4) var(--space-6) var(--space-12);
	}

	header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--space-4);
		background: var(--background-strong);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-lg);
		padding: var(--space-4);
		margin-bottom: var(--space-4);
	}

	.head-main {
		min-width: 0;
	}

	/* Time block: pinned to the top-right corner and stacked (docs/ui-standards.md). */
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

	.time-range {
		color: var(--text-strong);
	}

	.duration {
		color: var(--text-base);
	}

	h1 {
		margin: 0 0 var(--space-1);
		font-size: var(--font-size-x-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1) var(--space-4);
		margin-top: var(--space-1);
		font-size: var(--font-size-small);
		color: var(--text-base);
	}

	.dir {
		color: var(--text-weak);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 28rem;
	}

	.cost {
		font-variant-numeric: tabular-nums;
		color: var(--text-strong);
	}

	.tokens {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
		font-size: var(--font-size-small);
	}

	.tokens li {
		font-variant-numeric: tabular-nums;
	}

	.selected {
		/* No divider above the chart (task #241): the header card and the Gantt
		   stay separated by whitespace only. The gap is owned by `header`'s
		   `margin-bottom`. */
		margin-top: 0;
		padding-top: 0;
	}

	.empty {
		color: var(--text-weak);
		border: 1px dashed var(--border-weak-base);
		border-radius: var(--radius-lg);
		padding: var(--space-8);
		text-align: center;
	}
</style>
