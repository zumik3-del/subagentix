<script lang="ts">
	/**
	 * Top-tools widget body (dashboard Phase 4, task #413; clickable errors
	 * #481; all-calls detail #484; pure renderer from the widget engine, #491).
	 *
	 * Content-only: `WidgetShell` owns the fetch, the payload-emptiness rule
	 * (registered on the descriptor) and the card chrome. This component maps the
	 * ready Tier-P payload to rank-ordered rows and renders `TopToolsTable` — the
	 * calls/name cells open the in-place "all calls" detail and the errors cell
	 * opens the failures-only detail. The detail callback now comes from the
	 * dashboard shell through context (task #492), not through prop threading.
	 *
	 * `getTopTools` caps its `part` scan at `MAX_TOOL_SESSIONS` (the Tier-P
	 * ceiling) and flags `capped`; `period=all` is also the unbounded slow path.
	 * Either case renders the visible note from {@link topToolsNote}, which needs
	 * the active period the shell forwards as `filter`.
	 */
	import type { ToolCallStatus } from '$lib/model/tool-errors';
	import type { WidgetRenderProps } from './widget';
	import { detailTargetFor, getDetailControls } from './detail';
	import { topToolRows, topToolsNote } from './top-tools';
	import TopToolsTable from './TopToolsTable.svelte';

	let { data, filter }: WidgetRenderProps<'top-tools'> = $props();

	/** Overlay controls from the shell; `undefined` in a standalone render. */
	const detail = getDetailControls();

	/** Opens the tool-call detail behind the matching registry target. */
	function openToolDetail(tool: string, mode: ToolCallStatus): void {
		detail?.openDetail(detailTargetFor(tool, mode));
	}

	/** Rank-ordered rows (count desc, name asc) from the server. */
	let rows = $derived(topToolRows(data));

	/** Capped/all-period explanation, or `null` when the counts are exact. */
	let note = $derived(topToolsNote(data, filter.period));
</script>

{#if note}
	<p class="top-tools__note">{note}</p>
{/if}
<TopToolsTable {rows} onOpenToolDetail={detail ? openToolDetail : undefined} />

<style>
	.top-tools__note {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--text-weak);
	}
</style>
