<script lang="ts">
	/**
	 * Node summary strip (extracted from `NodeDetailPanel`, ADR 2.2).
	 *
	 * The `Node summary` section: the identity row plus four single-line
	 * summary columns (Retries, Markers, Tracker links, Permissions). Pure
	 * presentation — the panel root owns the derivations (`retryGroups`,
	 * `trackerRefs`, `refBase`, `permissionRows`) and the tracker callback and
	 * passes them down. The line items are authored here and framed by
	 * `SummaryLine`, which owns the `.line` wrapper, the overflow counter and
	 * the `clampLine` action.
	 */
	import type { NodeDetail, PermissionInfo } from '$lib/model/types';
	import { clock } from '$lib/model/clock.svelte';
	import { formatClock } from '$lib/model/format';
	import type { ToolRetryGroup } from '$lib/model/node';
	import NodeIdentity from './NodeIdentity.svelte';
	import SummaryLine from '$lib/components/composites/SummaryLine.svelte';
	import TrackerChipList from '$lib/components/composites/TrackerChipList.svelte';

	interface Props {
		detail: NodeDetail;
		retryGroups: ToolRetryGroup[];
		trackerRefs: string[];
		refBase: string | null;
		/** Permission prompts recorded on the node's tool calls. */
		permissionRows: PermissionInfo[];
		/** Feature toggle: when false the tracker column is hidden. */
		ziptaskEnabled: boolean;
		/** Open the task-detail modal for an inferred ref (owned by `Gantt`). */
		onOpenTask?: (ref: string) => void;
	}

	let {
		detail,
		retryGroups,
		trackerRefs,
		refBase,
		permissionRows,
		ziptaskEnabled,
		onOpenTask
	}: Props = $props();
</script>

<section aria-label="Node summary">
	<div class="summary-strip">
		<NodeIdentity node={detail.node} />
		<div class="summary-row">
			<SummaryLine signal={detail} overflow={retryGroups.length > 0}>
				<h4 class="line-label">Retries ({retryGroups.length})</h4>
				{#if retryGroups.length === 0}
					<span class="empty">No retries.</span>
				{:else}
					<ul class="line-list">
						{#each retryGroups as group (group.name)}
							<li class="line-item" data-overflow-item class:has-error={group.hasError}>
								<span class="name mono">{group.name}</span>
								<span class="muted">
									{group.calls.length} invocations · {group.retryCount} retr{group.retryCount === 1
										? 'y'
										: 'ies'}{group.hasError ? ' · includes error' : ''}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</SummaryLine>
		</div>
		<div class="summary-row summary-row--rest">
			<section class="summary-col">
				<SummaryLine signal={detail} overflow={detail.markers.length > 0}>
					<h4 class="line-label">Markers ({detail.markers.length})</h4>
					{#if detail.markers.length === 0}
						<span class="empty">No compaction or removed-content markers.</span>
					{:else}
						<ul class="line-list">
							{#each detail.markers as marker, index (marker.type + index)}
								<li class="line-item" data-overflow-item>
									<span class={`ui-badge ui-badge--${marker.type}`}>{marker.type}</span>
									<span class="muted">
										{marker.type === 'compaction'
											? marker.at === null
												? 'context summarization point'
												: `context summarization at ${formatClock(marker.at, clock.tz)}`
											: 'removed content (no timestamp)'}
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</SummaryLine>
			</section>
			{#if ziptaskEnabled}
				<section class="summary-col">
					<SummaryLine signal={detail} clip={false}>
						<h4 class="line-label">
							Tracker links <span class="muted">(inferred)</span>
						</h4>
						{#if trackerRefs.length === 0}
							<span class="empty">No tracker link.</span>
						{:else if refBase === null}
							<span class="empty">ZIPTASK_BASE_URL is not configured.</span>
						{:else}
							<TrackerChipList refs={trackerRefs} onOpen={onOpenTask} />
						{/if}
					</SummaryLine>
				</section>
			{/if}
			<section class="summary-col">
				<SummaryLine signal={detail} overflow={permissionRows.length > 0}>
					<h4 class="line-label">Permissions ({permissionRows.length})</h4>
					{#if permissionRows.length === 0}
						<span class="empty">No permission prompts recorded.</span>
					{:else}
						<ul class="line-list">
							{#each permissionRows as permission (permission.requestId)}
								<li class="line-item" data-overflow-item>
									<span
										class={`ui-badge ${permission.reply === 'reject' ? 'ui-badge--removed' : 'ui-badge--perm'}`}
									>
										{permission.reply ?? 'pending'}
									</span>
									<span class="muted">
										{permission.permission || 'permission'}{permission.patterns.length
											? ` · ${permission.patterns.join(', ')}`
											: ''}
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</SummaryLine>
			</section>
		</div>
	</div>
</section>

<style>
	/* One block: identity, then Retries, then the three columns — two
	   single-line rows, so the height stays stable when switching nodes.
	   No divider or extra spacing between them. */
	.summary-strip {
		display: grid;
		gap: var(--space-2);
	}

	.summary-row {
		min-width: 0;
	}

	.summary-row--rest {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		align-items: start;
		gap: var(--space-3) var(--space-5);
	}

	.summary-col {
		min-width: 0;
	}

	/* The line content is authored here as snippet blocks, so its scoped
	   styles live here too (they do not cross into `SummaryLine`); the
	   `.line` wrapper and `.line-more` counter are owned by `SummaryLine`. */
	.line-label {
		flex: 0 0 auto;
		margin: 0;
		font-size: var(--font-size-small);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.line-list {
		flex: 0 0 auto;
		display: flex;
		flex-wrap: nowrap;
		gap: var(--space-3);
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: var(--font-size-small);
	}

	.line-item {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-1);
		flex: 0 0 auto;
		white-space: nowrap;
	}

	.line-item.has-error .name {
		color: var(--color-danger-strong);
	}

	/* Shared text helpers also used by the extracted list items; the panel
	   keeps its own copies for the Details block. */
	.empty {
		color: var(--text-weak);
		font-size: var(--font-size-small);
		margin: 0;
		display: flex;
		align-items: center;
		min-height: var(--space-6);
	}

	.name {
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.mono {
		font-family: var(--font-family-mono);
		font-size: var(--font-size-sm);
	}
</style>
