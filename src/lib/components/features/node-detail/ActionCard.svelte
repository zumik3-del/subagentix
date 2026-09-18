<script lang="ts">
	/**
	 * One non-tool action card (extracted from `NodeDetailPanel`, ADR 2.4).
	 *
	 * The action `<li>` of the Details list. `text`/`reasoning` actions render
	 * through the shared `ToolCallDetail` (status dot + kind name + content
	 * block, plus the copy button), matching the tool cards; every other kind
	 * keeps the badge-head + content `IoBlock` path (task #541). Pure
	 * presentation — the panel root owns the `expanded` / `flashId` state and
	 * the `toggleExpanded` handler and passes them down. The stable jump id
	 * `action-<id>` is produced here so the panel's scroll targets keep
	 * resolving.
	 */
	import type { Action } from '$lib/model/types';
	import { clock } from '$lib/model/clock.svelte';
	import { formatClock } from '$lib/model/format';
	import { truncateText } from '$lib/model/node';
	import IoBlock from '$lib/components/composites/IoBlock.svelte';
	import ToolCallDetail from '$lib/components/composites/ToolCallDetail.svelte';

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

	/** `text`/`reasoning` render through the shared call card (task #541). */
	const asCall = $derived(action.kind === 'text' || action.kind === 'reasoning');

	/** Stable DOM id for an action's detail card, used as the jump target. */
	function actionDomId(id: string): string {
		return `action-${id}`;
	}
</script>

<li class="call action-card" class:flash={flashId === actionDomId(action.id)} id={actionDomId(action.id)}>
	{#if asCall}
		<ToolCallDetail
			call={{
				id: action.id,
				name: action.kind,
				status: '',
				error: null,
				startedAt: action.at,
				endedAt: action.endedAt,
				input: null,
				output: null,
				isMcp: false,
				isDelegation: false,
				dotTone: `kind-${action.kind}`,
				content: action.summary
			}}
			{expanded}
			{onToggleExpanded}
		/>
	{:else}
		<div class="call-head">
			<span class={`ui-badge ui-badge--${action.kind}`}>{action.kind}</span>
			{#if action.label && action.label !== action.kind}
				<span class="name mono">{action.label}</span>
			{/if}
			<span class="muted">
				{formatClock(action.at, clock.tz)}{action.endedAt !== null
					? ` → ${formatClock(action.endedAt, clock.tz)}`
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
