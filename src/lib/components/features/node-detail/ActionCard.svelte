<script lang="ts">
	/**
	 * One non-tool action card (extracted from `NodeDetailPanel`, ADR 2.4).
	 *
	 * The action `<li>` of the Details list: the kind badge, optional label,
	 * time range and the optional content `IoBlock`. Pure presentation — the
	 * panel root owns the `expanded` / `flashId` state and the
	 * `toggleExpanded` handler and passes them down. The stable jump id
	 * `action-<id>` is produced here so the panel's scroll targets keep
	 * resolving.
	 */
	import type { Action } from '$lib/model/types';
	import { formatClock } from '$lib/model/format';
	import { truncateText } from '$lib/model/node';
	import IoBlock from '$lib/components/composites/IoBlock.svelte';

	interface Props {
		action: Action;
		/** Expanded rows/blobs, keyed by step row key or `<actionId>:action`. */
		expanded: Record<string, boolean>;
		/** Details block just jumped to; drives the temporary grey flash. */
		flashId: string | null;
		/** Toggle the expanded state for an `<actionId>:action` key. */
		onToggleExpanded: (key: string) => void;
	}

	let { action, expanded, flashId, onToggleExpanded }: Props = $props();

	/** Character budget for an action summary snippet (mirrors the panel root). */
	const SNIPPET_LIMIT = 600;

	const body = $derived(truncateText(action.summary, SNIPPET_LIMIT));

	/** Stable DOM id for an action's detail card, used as the jump target. */
	function actionDomId(id: string): string {
		return `action-${id}`;
	}
</script>

<li class="call action-card" class:flash={flashId === actionDomId(action.id)} id={actionDomId(action.id)}>
	<div class="call-head">
		<span class={`ui-badge ui-badge--${action.kind}`}>{action.kind}</span>
		{#if action.label && action.label !== action.kind}
			<span class="name mono">{action.label}</span>
		{/if}
		<span class="muted">
			{formatClock(action.at)}{action.endedAt !== null
				? ` → ${formatClock(action.endedAt)}`
				: ''}
		</span>
	</div>
	{#if action.summary}
		<IoBlock
			label="content"
			expanded={expanded[`${action.id}:action`]}
			truncated={body.truncated}
			originalLength={body.originalLength}
			onToggle={() => onToggleExpanded(`${action.id}:action`)}
		>
			{expanded[`${action.id}:action`] ? action.summary : body.text}
		</IoBlock>
	{/if}
</li>

<style>
	/* `.call` / `.call-head` are mirrored from the panel's Details CSS; the
	   list wrapper (`ul.calls`) lives in `NodeDetailsList`. */
	.call {
		position: relative;
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
		padding: var(--space-2) var(--space-3);
		background: var(--surface-base);
		transition: background-color 220ms ease;
	}

	/* Temporary grey flash on the block a table row jumped to. */
	.call.flash {
		background: var(--surface-raised-base-hover);
	}

	.call-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--font-size-small);
		padding-right: var(--space-8);
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
