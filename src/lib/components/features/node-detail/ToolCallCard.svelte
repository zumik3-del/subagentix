<script lang="ts">
	/**
	 * One tool/MCP call card (extracted from `NodeDetailPanel`, ADR 2.4).
	 *
	 * The tool `<li>` of the Details list: the stable jump id and the flash
	 * state. The card interior (head row, input/output/content/error blocks and
	 * the self-contained copy button) is delegated to the shared
	 * `ToolCallDetail`, which the dashboard call detail reuses (tasks #538,
	 * #541). Pure presentation — the panel root owns the `expanded` /
	 * `flashId` state and the `toggleExpanded` handler and passes them down;
	 * `nodeStartedAt` resolves the duration fallback for a call with no
	 * timestamp.
	 */
	import type { ToolCall } from '$lib/model/types';
	import ToolCallDetail from '$lib/components/composites/ToolCallDetail.svelte';

	interface Props {
		call: ToolCall;
		/** Expanded rows/blobs, keyed by step row key or `<callId>:<field>`. */
		expanded: Record<string, boolean>;
		/** Details block just jumped to; drives the temporary grey flash. */
		flashId: string | null;
		/** Fallback start for a call with no timestamp (mirrors the old `startOf`). */
		nodeStartedAt: number;
		/** Toggle the expanded state for a `<callId>:<field>` key. */
		onToggleExpanded: (key: string) => void;
	}

	let { call, expanded, flashId, nodeStartedAt, onToggleExpanded }: Props = $props();

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
</style>
