<script lang="ts">
	import type { PageProps } from './$types';
	import Gantt from '$lib/components/features/gantt/Gantt.svelte';
	import SessionOverview from '$lib/components/features/session/SessionOverview.svelte';
	import { displayAgent } from '$lib/model/agent';
	import { clock } from '$lib/model/clock.svelte';
	import {
		formatClock,
		formatCost,
		formatDate,
		formatDuration,
		formatNumber,
		tokenBreakdown
	} from '$lib/model/format';

	let { data }: PageProps = $props();

	/**
	 * Message for the streamed-model error state. SvelteKit rejects a streamed
	 * load promise with a normalised `{ message }` object; fall back to a generic
	 * message for anything else so the UI never renders `undefined`.
	 */
	function ganttErrorMessage(reason: unknown): string {
		if (reason !== null && typeof reason === 'object' && 'message' in reason) {
			const message = (reason as { message?: unknown }).message;
			if (typeof message === 'string' && message !== '') return message;
		}
		return 'Could not load the turn Gantt.';
	}
</script>

<main>
	<header>
		<div class="head-main">
			<h1>{data.session.title || data.session.id}</h1>
			<div class="meta">
				<span class="ui-chip">{displayAgent(data.session.agent)}</span>
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
				{formatClock(data.session.createdAt, clock.tz)} → {formatClock(data.session.updatedAt, clock.tz)}
			</span>
			<span class="date">
				{#if formatDate(data.session.createdAt, clock.tz) === formatDate(data.session.updatedAt, clock.tz)}
					{formatDate(data.session.createdAt, clock.tz)}
				{:else}
					{formatDate(data.session.createdAt, clock.tz)} → {formatDate(data.session.updatedAt, clock.tz)}
				{/if}
			</span>
			<span class="duration">
				{formatDuration(data.session.createdAt, data.session.updatedAt)}
			</span>
		</div>
	</header>

	{#if data.gantt}
		<section class="selected">
			<!-- Lightweight way back to the overview (task #535): same route, no
			     new segment — dropping `?turn=` restores the session body. -->
			<a
				class="ui-link-btn overview-link"
				href={`/sessions/${encodeURIComponent(data.session.id)}`}
			>
				← Session overview
			</a>
			<!-- Non-blocking (task #385): the model streams in as a promise, so the
			     header above renders immediately and this section shows a skeleton
			     until it resolves. SSR renders the pending branch and hydration
			     matches it (the promise is still pending at first client render). -->
			{#await data.gantt}
				<div class="gantt-loading" role="status" aria-live="polite">
					<span class="sr-only">Loading turn Gantt…</span>
					<div class="gantt-skeleton" aria-hidden="true">
						<span class="sk sk-head"></span>
						<span class="sk sk-row"></span>
						<span class="sk sk-row sk-row--short"></span>
						<span class="sk sk-row"></span>
						<span class="sk sk-row sk-row--short"></span>
					</div>
				</div>
			{:then model}
				<Gantt
					model={model}
					turnIndex={data.turns.find((turn) => turn.turnId === model.triggerMessageId)?.index ?? null}
					ziptaskEnabled={data.ziptaskEnabled}
					ziptaskBaseUrl={data.ziptaskBaseUrl}
					agentColors={data.agentColors}
				/>
			{:catch reason}
				<p class="load-error" role="alert">{ganttErrorMessage(reason)}</p>
			{/await}
		</section>
	{:else}
		<SessionOverview
			session={data.session}
			turns={data.turns}
			turnWindow={data.turnWindow}
			subagents={data.children}
		/>
	{/if}
</main>

<style>
	main {
		width: 100%;
		padding: var(--space-4) var(--space-4) var(--space-12);
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

	/* `ui-link-btn` is action-styled; as an anchor it needs the underline off. */
	.overview-link {
		display: inline-block;
		margin-bottom: var(--space-2);
		text-decoration: none;
	}

	/* Loading skeleton for the streamed Gantt model (task #385). It mirrors the
	   chart card surface so the swap to the real chart does not shift layout. */
	.gantt-loading {
		background: var(--background-strong);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-lg);
		padding: var(--space-4);
	}

	.gantt-skeleton {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.sk {
		display: block;
		height: var(--space-4);
		border-radius: var(--radius-sm);
		background: var(--surface-raised-base);
		animation: gantt-skeleton-pulse 1.2s ease-in-out infinite;
	}

	.sk-head {
		height: var(--space-6);
		width: 40%;
	}

	.sk-row {
		width: 100%;
	}

	.sk-row--short {
		width: 70%;
	}

	@keyframes gantt-skeleton-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.55;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.sk {
			animation: none;
		}
	}

	.load-error {
		margin: 0;
		padding: var(--space-4);
		color: var(--color-danger-strong);
		background: var(--color-danger-surface);
		border: 1px solid var(--color-danger-border);
		border-radius: var(--radius-lg);
	}
</style>
