<script lang="ts">
	/**
	 * One tool/MCP call card (extracted from `NodeDetailPanel`, ADR 2.4).
	 *
	 * The tool `<li>` of the Details list: the copy button, the head row
	 * (status dot, name, badges, duration) and the input/output `IoBlock`s.
	 * Pure presentation — the panel root owns the `expanded` /
	 * `copiedCallId` / `flashId` state and the `copyCall` / `toggleExpanded`
	 * handlers and passes them down. The stable jump id `tool-call-<id>` is
	 * produced here so the panel's scroll targets keep resolving.
	 */
	import type { ToolCall } from '$lib/model/types';
	import { formatDuration } from '$lib/model/format';
	import { truncateText } from '$lib/model/node';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import IoBlock from '$lib/components/composites/IoBlock.svelte';

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

	/** Character budget for a tool input/output snippet (mirrors the panel root). */
	const SNIPPET_LIMIT = 600;

	const input = $derived(truncateText(call.input, SNIPPET_LIMIT));
	const output = $derived(truncateText(call.output, SNIPPET_LIMIT));

	/** Stable DOM id for a tool-call row, used as the jump target. */
	function callDomId(id: string): string {
		return `tool-call-${id}`;
	}

	/** Duration start: the call's own timestamp, else the node's start. */
	function startOf(value: number | null): number {
		return value ?? nodeStartedAt;
	}

	/** Status → dot tone (mirrors the panel's table mapping). */
	function statusTone(status: string): string {
		switch (status.toLowerCase()) {
			case 'completed':
			case 'complete':
			case 'success':
				return 'ok';
			case 'error':
			case 'failed':
				return 'err';
			case 'running':
			case 'pending':
				return 'run';
			default:
				return 'other';
		}
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
	<div class="call-head">
		<span class={`dot dot-${statusTone(call.status)}`}></span>
		<span class="name mono">{call.name}</span>
		<span class="ui-badge">{call.status}</span>
		{#if call.isMcp}<span class="ui-badge ui-badge--mcp">MCP</span>{/if}
		{#if call.isDelegation}<span class="ui-badge ui-badge--deleg">delegation</span>{/if}
		{#if call.permission}
			<span
				class="ui-badge ui-badge--perm"
				title={`Permission ${call.permission.permission}${
					call.permission.patterns.length
						? ` · ${call.permission.patterns.join(', ')}`
						: ''
				}`}
			>
				permission: {call.permission.reply ?? 'pending'}
			</span>
		{/if}
		<span class="muted">{formatDuration(startOf(call.startedAt), call.endedAt)}</span>
	</div>
	{#if call.error}
		<p class="error">{call.error}</p>
	{/if}
	{#if call.input !== null && call.input !== ''}
		<IoBlock
			label="input"
			expanded={expanded[`${call.id}:input`]}
			truncated={input.truncated}
			originalLength={input.originalLength}
			onToggle={() => onToggleExpanded(`${call.id}:input`)}
		>
			{expanded[`${call.id}:input`] ? call.input : input.text}
		</IoBlock>
	{/if}
	{#if call.output !== null && call.output !== ''}
		<IoBlock
			label="output"
			expanded={expanded[`${call.id}:output`]}
			truncated={output.truncated}
			originalLength={output.originalLength}
			onToggle={() => onToggleExpanded(`${call.id}:output`)}
		>
			{expanded[`${call.id}:output`] ? call.output : output.text}
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

	.copy {
		position: absolute;
		top: var(--space-1);
		right: var(--space-1);
	}

	.dot {
		display: inline-block;
		width: 0.55rem;
		height: 0.55rem;
		border-radius: var(--radius-full);
		flex: 0 0 auto;
		vertical-align: middle;
	}

	/* Muted fills mirroring the Details badge palette (the -strong tone)
	   instead of the bright -base accents. */
	.dot-ok {
		background: var(--color-success-strong);
	}
	.dot-err {
		background: var(--color-danger-strong);
	}
	.dot-run {
		background: var(--color-warning-strong);
	}
	.dot-other {
		background: var(--icon-base);
	}

	.name {
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.mono {
		font-family: var(--font-family-mono);
		font-size: var(--font-size-sm);
	}

	.error {
		color: var(--color-danger-strong);
		font-size: var(--font-size-sm);
		margin: var(--space-1) 0 0;
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
