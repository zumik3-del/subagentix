<script lang="ts">
	/**
	 * One tool/MCP call detail card (extracted from `ToolCallCard`, task #538).
	 *
	 * The shared interior of a tool-call record: the head row (status dot, name,
	 * badges, duration), the error text when present and the input/output
	 * `IoBlock`s. Used by the Gantt node inspector's `ToolCallCard` and by the
	 * dashboard `ToolErrorsModal` rows, so a call reads the same everywhere.
	 *
	 * Pure presentation — the host owns the wrapper (`<li>` / `<td>`), the copy
	 * button, the jump DOM id and the `expanded` record, and passes the call's
	 * view model plus an `onToggleExpanded(key)` callback down. The input/output
	 * blocks key off `<id>:input` / `<id>:output`, so a host that embeds several
	 * cards can still expand the blobs independently. The `ToolCall` model and a
	 * dashboard `ToolErrorEntry` both satisfy the view model structurally; a host
	 * resolves a missing start time (e.g. `nodeStartedAt`) before passing it.
	 */
	import { formatDuration } from '$lib/model/format';
	import { truncateText } from '$lib/model/node';
	import IoBlock from './IoBlock.svelte';

	/** The structural tool-call view model this card renders. */
	interface ToolCallView {
		/** `part.id`; keys the two blob expand entries. */
		id: string;
		name: string;
		/** Raw status text; an empty string renders no badge. */
		status: string;
		error: string | null;
		/** Resolved start time; `null` renders an unknown duration. */
		startedAt: number | null;
		/** `null` => still running. */
		endedAt: number | null;
		input: string | null;
		output: string | null;
		isMcp: boolean;
		isDelegation: boolean;
	}

	interface Props {
		/** The call to render (a `ToolCall` satisfies this structurally). */
		call: ToolCallView;
		/** Expanded rows/blobs, keyed by `<callId>:<field>`. */
		expanded: Record<string, boolean>;
		/** Toggle the expanded state for a `<callId>:<field>` key. */
		onToggleExpanded: (key: string) => void;
	}

	let { call, expanded, onToggleExpanded }: Props = $props();

	/** Character budget for a tool input/output snippet (mirrors the host). */
	const SNIPPET_LIMIT = 600;

	const input = $derived(truncateText(call.input, SNIPPET_LIMIT));
	const output = $derived(truncateText(call.output, SNIPPET_LIMIT));

	/** Human duration; a host resolves the start fallback before passing it. */
	const duration = $derived(
		call.startedAt === null ? '—' : formatDuration(call.startedAt, call.endedAt)
	);

	/** Status → dot tone (mirrors the Details table mapping). */
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

<div class="call-head">
	<span class={`dot dot-${statusTone(call.status)}`}></span>
	<span class="name mono">{call.name}</span>
	{#if call.status !== ''}
		<span class="ui-badge">{call.status}</span>
	{/if}
	{#if call.isMcp}<span class="ui-badge ui-badge--mcp">MCP</span>{/if}
	{#if call.isDelegation}<span class="ui-badge ui-badge--deleg">delegation</span>{/if}
	<span class="muted">{duration}</span>
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

<style>
	.call-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--font-size-small);
		padding-right: var(--space-8);
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
