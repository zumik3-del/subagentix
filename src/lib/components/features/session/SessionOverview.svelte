<script lang="ts">
	/**
	 * Session overview body (task #535): what `/sessions/[id]` shows when no
	 * `?turn=` is selected. Presentational only — the page loader owns the data
	 * (the `SessionDetail` plus its windowed turns) and passes it down; the
	 * component fetches nothing and imports no `$lib/server` code, so it is safe
	 * in the client bundle.
	 *
	 * Three parts: the server-windowed turn list (each turn links to its Gantt,
	 * with Older/Newer paging), the subagent subtree indented by `depth`, and a
	 * subtree-totals strip that sums the root's usage with every descendant's
	 * (`addUsage`). A leaf session with neither turns nor children shows a
	 * single laconic line instead of empty sections.
	 */
	import type { ChildSession, SessionSummary, TurnSummary, TurnWindow } from '$lib/model/types';
	import { displayAgent } from '$lib/model/agent';
	import { clock } from '$lib/model/clock.svelte';
	import { formatCost, formatDateTime, formatDuration, formatNumber } from '$lib/model/format';
	import { turnPageTargets } from '$lib/model/paging';
	import { addUsage } from '$lib/model/token';

	interface Props {
		session: SessionSummary;
		/** The server-windowed slice (`data.turns`), ascending by turn index. */
		turns: TurnSummary[];
		/** Window bounds/counters that drive the Older/Newer controls. */
		turnWindow: TurnWindow;
		/** Direct and transitive descendant sessions of the root. */
		subagents: ChildSession[];
	}

	let { session, turns, turnWindow, subagents }: Props = $props();

	const pageTargets = $derived(turnPageTargets(turnWindow));
	const subtreeUsage = $derived(
		subagents.reduce((total, child) => addUsage(total, child.usage), session.usage)
	);

	/** A root session with neither turns nor descendants has nothing to list. */
	const isLeaf = $derived(turns.length === 0 && subagents.length === 0);

	function turnHref(turnId: string): string {
		return `/sessions/${encodeURIComponent(session.id)}?turn=${encodeURIComponent(turnId)}`;
	}

	function windowHref(start: number): string {
		return `/sessions/${encodeURIComponent(session.id)}?turnStart=${start}`;
	}
</script>

<section class="overview" aria-label="Session overview">
	{#if isLeaf}
		<p class="empty">No turns or subagents.</p>
	{:else}
		{#if turns.length > 0}
			<section class="ui-card" aria-label="Turns">
				<h2 class="section-title">Turns ({turnWindow.total})</h2>
				<ul class="turn-list">
					{#each turns as turn (turn.turnId)}
						<li>
							<a class="turn-link" href={turnHref(turn.turnId)}>
								<span class="turn-index">Turn {turn.index}</span>
								<span class="muted">{formatDateTime(turn.startedAt, clock.tz)}</span>
								<span class="muted">
									{`${turn.assistantCount} assistant ${turn.assistantCount === 1 ? 'message' : 'messages'}`}
								</span>
							</a>
						</li>
					{/each}
				</ul>
				<nav class="pager" aria-label="Turn pages">
					{#if turnWindow.hasOlder}
						<a class="ui-btn pager-control" href={windowHref(pageTargets.older ?? 0)}>
							Load older turns ({turnWindow.hiddenOlder})
						</a>
					{:else}
						<span class="pager-control pager-control--off">Load older turns</span>
					{/if}
					<span class="pager-range">
						Showing {turnWindow.start + 1}–{turnWindow.end} of {turnWindow.total}
					</span>
					{#if turnWindow.hasNewer}
						<a class="ui-btn pager-control" href={windowHref(pageTargets.newer ?? turnWindow.end)}>
							Newer turns ({turnWindow.hiddenNewer}) →
						</a>
					{:else}
						<span class="pager-control pager-control--off">Newer turns →</span>
					{/if}
				</nav>
			</section>
		{/if}

		{#if subagents.length > 0}
			<section class="ui-card" aria-label="Subagents">
				<h2 class="section-title">Subagents ({subagents.length})</h2>
				<ul class="child-list">
					{#each subagents as child (child.id)}
						<li class="child-row" style:--depth={child.depth}>
							<a class="child-link" href={`/sessions/${encodeURIComponent(child.id)}`}>
								<span class="child-agent">{displayAgent(child.agent)}</span>
								<span class="muted">{formatDuration(child.createdAt, child.updatedAt)}</span>
								<span class="child-cost">{formatCost(child.usage.cost)}</span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<section class="ui-card" aria-label="Subtree totals">
			<h2 class="section-title">Subtree totals</h2>
			<ul class="totals-list">
				<li><span class="muted">Sessions</span> {subagents.length + 1}</li>
				<li><span class="muted">Total tokens</span> {formatNumber(subtreeUsage.total)}</li>
				<li><span class="muted">Cost (gross)</span> {formatCost(subtreeUsage.cost)}</li>
			</ul>
		</section>
	{/if}
</section>

<style>
	.overview {
		display: grid;
		gap: var(--space-4);
	}

	.section-title {
		margin: 0;
		font-size: var(--font-size-small);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.empty {
		margin: 0;
		padding: var(--space-8);
		text-align: center;
		color: var(--text-weak);
		border: 1px dashed var(--border-weak-base);
		border-radius: var(--radius-lg);
	}

	.turn-list,
	.child-list,
	.totals-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.turn-list,
	.child-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.turn-link,
	.child-link {
		display: flex;
		align-items: baseline;
		gap: var(--space-4);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-sm);
		color: var(--text-base);
		text-decoration: none;
	}

	.turn-link:hover,
	.child-link:hover {
		background: var(--overlay-hover);
		color: var(--text-strong);
	}

	.turn-index,
	.child-agent {
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	/* Child indentation is data (depth relative to the root). */
	.child-row {
		padding-inline-start: calc(var(--depth, 0) * var(--space-4));
	}

	.child-cost {
		font-variant-numeric: tabular-nums;
	}

	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.pager-control {
		font-size: var(--font-size-small);
		text-decoration: none;
	}

	.pager-control--off {
		color: var(--text-weak);
	}

	.pager-range {
		color: var(--text-weak);
		font-size: var(--font-size-small);
		font-variant-numeric: tabular-nums;
	}

	.totals-list {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-5);
		font-size: var(--font-size-small);
		font-variant-numeric: tabular-nums;
		color: var(--text-strong);
	}
</style>
