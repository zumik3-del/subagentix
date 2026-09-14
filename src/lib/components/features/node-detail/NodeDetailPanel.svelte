<script lang="ts">
	/**
	 * Node drill-down panel (M3c).
	 *
	 * Renders one node's slice of the already-loaded `GanttModel` (no fetch): its
	 * steps, tool/MCP calls with truncation + expand, retry grouping, compaction
	 * markers, inferred ziptask chips and a raw-JSON toggle. Pure presentation —
	 * the data comes from `selectNodeDetail` / the API route, both server-free.
	 *
	 * The Steps & actions table is delegated to `NodeActionsTable` (ADR 2.6):
	 * this feature root keeps all interactive state (filters, expansion, copy,
	 * flash) and the cross-block scroll/jump helpers, and passes precomputed
	 * props plus callbacks down.
	 *
	 * No raw HTML injection: every dynamic value is escaped by Svelte.
	 */
	import { onDestroy, tick } from 'svelte';
	import type { NodeDetail, ToolCall } from '$lib/model/types';
	import {
		buildDetailEntries,
		buildNodeRows,
		collectTrackerRefs,
		formatToolCallText,
		groupToolRetries
	} from '$lib/model/node';
	import type { NodeRow } from '$lib/model/node';
	import { TOKEN_LABELS } from '$lib/model/token';
	import NodeSummaryStrip from './NodeSummaryStrip.svelte';
	import NodeActionsTable, { type RowFilter } from './NodeActionsTable.svelte';
	import NodeDetailsList from './NodeDetailsList.svelte';
	import RawJsonBlock from './RawJsonBlock.svelte';

	let {
		detail,
		ziptaskEnabled = true,
		ziptaskBaseUrl = null,
		onOpenTask
	}: {
		detail: NodeDetail;
		/** Feature toggle: when false the tracker column is hidden. */
		ziptaskEnabled?: boolean;
		ziptaskBaseUrl?: string | null;
		/** Open the task-detail modal for an inferred ref (owned by `Gantt`). */
		onOpenTask?: (ref: string) => void;
	} = $props();

	// Token categories in rendering order (matches `tokenBreakdown`).
	const usageColumns = [
		TOKEN_LABELS.input,
		TOKEN_LABELS.output,
		TOKEN_LABELS.reasoning,
		TOKEN_LABELS.cacheRead,
		TOKEN_LABELS.cacheWrite,
		TOKEN_LABELS.total
	];

	/** Steps & actions timeline: row filters + free-text search (client-side). */
	let kindFilter = $state<RowFilter>('all');
	let permissionOnly = $state(false);
	let actionSearch = $state('');

	/** Expanded rows/blobs, keyed by step row key or `<callId>:<field>`. */
	let expanded = $state<Record<string, boolean>>({});
	/** Tool-call id whose copy just succeeded (drives the brief check-icon feedback). */
	let copiedCallId = $state<string | null>(null);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;

	/** Details block just jumped to; drives the temporary grey flash. */
	let flashId = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | null = null;

	const retryGroups = $derived(groupToolRetries(detail.toolCalls));
	// Prefer the service-computed node refs (tool calls + `task` edges it
	// spawned); fall back to the raw tool-call refs for partial DTOs.
	const trackerRefs = $derived(
		detail.node.trackerRefs && detail.node.trackerRefs.length > 0
			? detail.node.trackerRefs
			: collectTrackerRefs(detail.toolCalls)
	);
	const refBase = $derived(ziptaskBaseUrl ? ziptaskBaseUrl.replace(/\/+$/, '') : null);

	// Hierarchical Steps & actions timeline: a start marker, the numbered LLM
	// steps, and (nested, collapsed by default) each step's tool calls and
	// non-tool actions. Filters: row kind, permission-only, free-text search.
	const rows = $derived(buildNodeRows(detail));
	const stepCount = $derived(rows.filter((row) => row.kind === 'step').length);
	const itemCount = $derived(
		rows.reduce(
			(count, row) => count + row.children.length + (row.kind === 'step' ? 0 : 1),
			0
		)
	);
	const permissionRows = $derived(
		detail.toolCalls.filter((call) => call.permission).map((call) => call.permission!)
	);
	/** Whether the node recorded anything at all (drives the empty state). */
	const hasContent = $derived(
		stepCount > 0 ||
			detail.toolCalls.length > 0 ||
			(detail.actions !== undefined && detail.actions.length > 0)
	);
	/** When a filter/search is active, matching steps expand so hits are visible. */
	const forceOpen = $derived(actionSearch.trim() !== '' || kindFilter !== 'all');
	interface VisibleRow {
		row: NodeRow;
		children: NodeRow[];
		/** Resolved by `isOpen`: expanded record entry OR an active filter. */
		open: boolean;
	}
	function kindMatches(row: NodeRow): boolean {
		switch (kindFilter) {
			case 'all':
				return true;
			case 'step':
				return row.kind === 'step';
			case 'tool':
				return row.kind === 'tool';
			case 'files':
				return row.kind === 'file' || row.kind === 'patch';
			case 'misc':
				return (
					row.kind === 'agent' ||
					row.kind === 'compaction' ||
					row.kind === 'start' ||
					row.kind === 'prompt'
				);
			default:
				return row.kind === kindFilter;
		}
	}
	function permissionAllows(row: NodeRow): boolean {
		return !(permissionOnly && row.kind === 'tool' && !row.call?.permission);
	}
	function leafMatches(row: NodeRow, query: string): boolean {
		return kindMatches(row) && permissionAllows(row) && (query === '' || searchText(row).includes(query));
	}
	function searchText(row: NodeRow): string {
		return `${row.label} ${row.summary}`.toLowerCase();
	}
	/** The visible row set, each entry carrying its resolved `open` flag. */
	const visibleRows = $derived.by((): VisibleRow[] => {
		const query = actionSearch.trim().toLowerCase();
		const out: VisibleRow[] = [];
		for (const row of rows) {
			if (row.kind === 'step') {
				const children = row.children.filter((child) => leafMatches(child, query));
				const showStep =
					(kindFilter === 'all' || kindFilter === 'step') && query === '' && !permissionOnly;
				if (children.length > 0 || showStep) out.push({ row, children, open: isOpen(row) });
			} else if (leafMatches(row, query)) {
				out.push({ row, children: [], open: isOpen(row) });
			}
		}
		return out;
	});
	function isOpen(row: NodeRow): boolean {
		return expanded[row.key] === true || forceOpen;
	}
	function toggleRow(key: string) {
		expanded[key] = !expanded[key];
	}
	const stepKeys = $derived(rows.filter((row) => row.kind === 'step').map((row) => row.key));
	const allExpanded = $derived(
		stepKeys.length > 0 && stepKeys.every((key) => expanded[key] === true)
	);
	function toggleAll() {
		if (allExpanded) {
			expanded = {};
		} else {
			for (const key of stepKeys) expanded[key] = true;
		}
	}

	// Unified details list below the table: tool calls + non-tool actions,
	// chronologically, each with a stable DOM anchor the table rows scroll to.
	const detailEntries = $derived(buildDetailEntries(detail));

	function toggleExpanded(key: string) {
		expanded[key] = !expanded[key];
	}
	/**
	 * Stable DOM id for a tool-call row, used as the jump target. Step/tool
	 * child attribution lives in `node.ts` `buildNodeRows`.
	 */
	function callDomId(id: string): string {
		return `tool-call-${id}`;
	}
	/** Scroll an element with `id` into view, honouring reduced-motion. */
	function scrollIntoViewId(id: string) {
		flashId = id;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => {
			flashId = null;
			flashTimer = null;
		}, 2000);
		document.getElementById(id)?.scrollIntoView({
			behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
			block: 'center'
		});
	}
	/** Scroll a tool-call block into view. */
	function scrollCallIntoView(id: string) {
		scrollIntoViewId(callDomId(id));
	}
	/** Stable DOM id for an action's detail card, used as the jump target. */
	function actionDomId(id: string): string {
		return `action-${id}`;
	}
	/** Scroll an action row's detail card into view. */
	function scrollToAction(id: string | null) {
		if (id) scrollIntoViewId(actionDomId(id));
	}
	/** Per-call jump: stop the row click from also firing, then scroll to that call. */
	async function focusCall(event: MouseEvent, id: string) {
		event.stopPropagation();
		await tick();
		scrollCallIntoView(id);
	}
	/** Per-action jump: stop the row click from also firing, then scroll. */
	async function focusAction(event: MouseEvent, id: string | null) {
		event.stopPropagation();
		await tick();
		scrollToAction(id);
	}
	/** Copy a call's full text dump; show a brief "copied" state or fail silently. */
	async function copyCall(call: ToolCall) {
		try {
			await navigator.clipboard.writeText(formatToolCallText(call));
			copiedCallId = call.id;
			if (copiedTimer) clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => {
				copiedCallId = null;
				copiedTimer = null;
			}, 1500);
		} catch {
			copiedCallId = null;
		}
	}
	onDestroy(() => {
		if (copiedTimer) clearTimeout(copiedTimer);
		if (flashTimer) clearTimeout(flashTimer);
	});
</script>

<section class="panel" aria-label="Node detail">
	<NodeSummaryStrip
		{detail}
		{retryGroups}
		{trackerRefs}
		{refBase}
		{permissionRows}
		{ziptaskEnabled}
		{onOpenTask}
	/>

	<NodeActionsTable
		{visibleRows}
		{stepCount}
		{itemCount}
		{hasContent}
		{usageColumns}
		{kindFilter}
		{permissionOnly}
		{actionSearch}
		{allExpanded}
		onSearch={(value) => (actionSearch = value)}
		onFilter={(value) => (kindFilter = value)}
		onTogglePermission={() => (permissionOnly = !permissionOnly)}
		onToggleAll={toggleAll}
		onToggleRow={toggleRow}
		onFocusCall={focusCall}
		onFocusAction={focusAction}
	/>

	<NodeDetailsList
		{detailEntries}
		{expanded}
		{copiedCallId}
		{flashId}
		nodeStartedAt={detail.node.startedAt}
		onCopy={copyCall}
		onToggleExpanded={toggleExpanded}
	/>

	<RawJsonBlock {detail} />
</section>

<style>
	.panel {
		margin-top: 0;
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-lg);
		/* Same uniform canvas as the Gantt block (issue #8). */
		background: var(--background-strong);
		padding: var(--space-4);
		color: var(--text-base);
	}
</style>
