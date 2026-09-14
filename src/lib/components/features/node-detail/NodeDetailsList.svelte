<script lang="ts">
	/**
	 * Unified details list (extracted from `NodeDetailPanel`, ADR 2.4).
	 *
	 * The `Details (N)` section: tool calls + non-tool actions, chronologically,
	 * each with a stable DOM anchor the table rows scroll to. Pure presentation
	 * — the panel root owns the `detailEntries`, `expanded`, `copiedCallId` and
	 * `flashId` state plus the `copyCall` / `toggleExpanded` handlers and passes
	 * them down. Every `<li>` is rendered by `ToolCallCard` / `ActionCard`.
	 */
	import type { DetailEntry } from '$lib/model/node';
	import type { ToolCall } from '$lib/model/types';
	import ToolCallCard from './ToolCallCard.svelte';
	import ActionCard from './ActionCard.svelte';

	interface Props {
		detailEntries: DetailEntry[];
		/** Expanded rows/blobs, keyed by step row key or `<id>:<field>`. */
		expanded: Record<string, boolean>;
		/** Tool-call id whose copy just succeeded (drives the check-icon feedback). */
		copiedCallId: string | null;
		/** Details block just jumped to; drives the temporary grey flash. */
		flashId: string | null;
		/** Node start, used as the duration fallback for an untimed tool call. */
		nodeStartedAt: number;
		/** Copy a call's full text dump (state stays in the panel root). */
		onCopy: (call: ToolCall) => void;
		/** Toggle the expanded state for a `<id>:<field>` key. */
		onToggleExpanded: (key: string) => void;
	}

	let {
		detailEntries,
		expanded,
		copiedCallId,
		flashId,
		nodeStartedAt,
		onCopy,
		onToggleExpanded
	}: Props = $props();
</script>

<section class="block">
	<h4>Details ({detailEntries.length})</h4>
	{#if detailEntries.length === 0}
		<p class="empty">No tool calls or actions recorded for this node.</p>
	{:else}
		<ul class="calls">
			{#each detailEntries as entry (entry.key)}
				{#if entry.kind === 'tool'}
					<ToolCallCard
						call={entry.call}
						{expanded}
						copied={copiedCallId === entry.call.id}
						{flashId}
						{nodeStartedAt}
						{onCopy}
						{onToggleExpanded}
					/>
				{:else}
					<ActionCard action={entry.action} {expanded} {flashId} {onToggleExpanded} />
				{/if}
			{/each}
		</ul>
	{/if}
</section>

<style>
	/* Section chrome mirrored from the panel: `block` is shared by the table
	   and raw-JSON sections that still live in `NodeDetailPanel`. */
	.block {
		margin-top: var(--space-4);
	}

	.block h4 {
		margin: 0 0 var(--space-1);
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.empty {
		color: var(--text-weak);
		font-size: var(--font-size-small);
		margin: 0;
		display: flex;
		align-items: center;
		min-height: var(--space-6);
	}

	.calls {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.calls {
		display: grid;
		gap: var(--space-2);
	}
</style>
