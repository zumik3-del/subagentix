<script lang="ts">
	/**
	 * One tool/MCP call card (extracted from `NodeDetailPanel`, ADR 2.4).
	 *
	 * The tool `<li>` of the Details list: the copy button, the stable jump id
	 * and the flash state. The card interior (head row, error, input/output
	 * blocks) is delegated to the shared `ToolCallDetail`, which the dashboard
	 * call detail reuses (task #538). Pure presentation — the panel root owns
	 * the `expanded` / `copiedCallId` / `flashId` state and the `copyCall` /
	 * `toggleExpanded` handlers and passes them down; `nodeStartedAt` resolves
	 * the duration fallback for a call with no timestamp.
	 */
	import type { ToolCall } from '$lib/model/types';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import ToolCallDetail from '$lib/components/composites/ToolCallDetail.svelte';

	interface Props {
		call: ToolCall;
		/** Expanded rows/blobs, keyed by step row key or `<callId>:<field>`. */
		expanded: Record<string, boolean>;
		/** Whether this call's copy button just succeeded (check-icon feedback). */
		copied: boolean;
		/** Details block just jumped to; drives the temporary grey flash. */
		flashId: string | null;
		/** Fallback start for a call with no timestamp (mirrors the old `startOf`). */
		nodeStartedAt: number;
		/** Copy this call's full text dump (state stays in the panel root). */
		onCopy: (call: ToolCall) => void;
		/** Toggle the expanded state for a `<callId>:<field>` key. */
		onToggleExpanded: (key: string) => void;
	}

	let { call, expanded, copied, flashId, nodeStartedAt, onCopy, onToggleExpanded }: Props = $props();

	/** Stable DOM id for a tool-call row, used as the jump target. */
	function callDomId(id: string): string {
		return `tool-call-${id}`;
	}

	/** Duration start: the call's own timestamp, else the node's start. */
	function startOf(value: number | null): number {
		return value ?? nodeStartedAt;
	}
</script>

<li class="call" class:flash={flashId === callDomId(call.id)} id={callDomId(call.id)}>
	<button
		type="button"
		class="ui-icon-btn copy"
		aria-label={copied ? 'Copied to clipboard' : `Copy ${call.name} call`}
		onclick={() => onCopy(call)}
	>
		{#if copied}
			<Icon name="check" size={14} />
			<span class="sr-only" role="status">Copied</span>
		{:else}
			<Icon name="copy" size={14} />
		{/if}
	</button>
	<ToolCallDetail
		call={{ ...call, startedAt: startOf(call.startedAt) }}
		{expanded}
		{onToggleExpanded}
	/>
</li>

<style>
	/* `.call` is mirrored from the panel's Details CSS; the list wrapper
	   (`ul.calls`) lives in `NodeDetailsList`. */
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

	.copy {
		position: absolute;
		top: var(--space-1);
		right: var(--space-1);
	}
</style>
