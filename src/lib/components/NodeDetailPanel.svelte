<script lang="ts">
	/**
	 * Node drill-down panel (M3c).
	 *
	 * Renders one node's slice of the already-loaded `GanttModel` (no fetch): its
	 * steps, tool/MCP calls with truncation + expand, retry grouping, compaction
	 * markers, inferred ziptask chips and a raw-JSON toggle. Pure presentation —
	 * the data comes from `selectNodeDetail` / the API route, both server-free.
	 *
	 * No raw HTML injection: every dynamic value is escaped by Svelte.
	 */
	import { onDestroy, tick } from 'svelte';
	import type { NodeDetail, Step, ToolCall } from '$lib/model/types';
	import { formatClock, formatCost, formatDuration, formatNumber, tokenBreakdown } from '$lib/model/format';
	import {
		buildDetailEntries,
		buildNodeRows,
		collectTrackerRefs,
		formatToolCallText,
		groupToolRetries,
		summarizeStepTools,
		truncateText
	} from '$lib/model/node';
	import type { NodeRow, StepToolSummary } from '$lib/model/node';
	import { displayAgent } from '$lib/model/agent';
	import { TOKEN_LABELS } from '$lib/model/token';
	import Icon from './Icon.svelte';
	import TreeIcon from './TreeIcon.svelte';
	import ScrollView from './ScrollView.svelte';

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

	/** Character budget for a tool input/output snippet. */
	const SNIPPET_LIMIT = 600;

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
	type RowFilter = 'all' | 'step' | 'tool' | 'text' | 'reasoning' | 'files' | 'misc';
	const ROW_FILTERS: ReadonlyArray<{ value: RowFilter; label: string }> = [
		{ value: 'all', label: 'All' },
		{ value: 'step', label: 'Steps' },
		{ value: 'tool', label: 'Tools' },
		{ value: 'text', label: 'Text' },
		{ value: 'reasoning', label: 'Reasoning' },
		{ value: 'files', label: 'Files' },
		{ value: 'misc', label: 'Other' }
	];
	let kindFilter = $state<RowFilter>('all');
	let permissionOnly = $state(false);
	let actionSearch = $state('');

	let showRaw = $state(false);
	/** Expanded rows/blobs, keyed by step row key or `<callId>:<field>`. */
	let expanded = $state<Record<string, boolean>>({});
	/** Tool-call id whose copy just succeeded (drives the brief check-icon feedback). */
	let copiedCallId = $state<string | null>(null);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;

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
	const visibleRows = $derived.by((): VisibleRow[] => {
		const query = actionSearch.trim().toLowerCase();
		const out: VisibleRow[] = [];
		for (const row of rows) {
			if (row.kind === 'step') {
				const children = row.children.filter((child) => leafMatches(child, query));
				const showStep =
					(kindFilter === 'all' || kindFilter === 'step') && query === '' && !permissionOnly;
				if (children.length > 0 || showStep) out.push({ row, children });
			} else if (leafMatches(row, query)) {
				out.push({ row, children: [] });
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
	function startOf(value: number | null): number {
		return value ?? detail.node.startedAt;
	}
	/**
	 * Stable DOM id for a tool-call row, used as the jump target. Step/tool
	 * child attribution lives in `node.ts` `buildNodeRows`.
	 */
	function callDomId(id: string): string {
		return `tool-call-${id}`;
	}
	/** Accessible description of a step's tools (raw reason kept as a tooltip). */
	function reasonTitle(stepNo: number, step: Step, summary: StepToolSummary): string {
		const errors = summary.errorCount > 0 ? ` · ${summary.errorCount} failed` : '';
		const raw = step.reason ? ` — ${step.reason}` : '';
		const plural = summary.count === 1 ? '' : 's';
		return `Step ${stepNo + 1}: ${summary.label} (${summary.count} tool call${plural})${errors}${raw}`;
	}
	/** Scroll an element with `id` into view, honouring reduced-motion. */
	function scrollIntoViewId(id: string) {
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
	});
</script>

<section class="panel" aria-label="Node detail">
	<header class="panel-head">
		<div>
			<h3>{displayAgent(detail.node.agent)} node</h3>
			<p class="muted mono">{detail.node.sessionId}</p>
		</div>
		<div class="meta">
			<span class="ui-chip">{detail.node.kind}</span>
			<span class="ui-chip">{detail.node.status}</span>
			<span class="ui-chip">{detail.node.modelId ?? 'unknown model'}</span>
			<span class="muted">
				{formatClock(detail.node.startedAt)} →
				{detail.node.endedAt === null ? 'running' : formatClock(detail.node.endedAt)}
				· {formatDuration(detail.node.startedAt, detail.node.endedAt)}
			</span>
			<span title="Cost (gross)">{formatCost(detail.node.usage.cost)}</span>
		</div>
	</header>

	<section class="block" aria-label="Node summary">
		<div class="summary-strip">
			<div class="summary-col">
				<h4>Retries ({retryGroups.length})</h4>
				{#if retryGroups.length === 0}
					<p class="empty">No retries.</p>
				{:else}
					<ul class="retries">
						{#each retryGroups as group (group.name)}
							<li class:has-error={group.hasError}>
								<span class="name mono">{group.name}</span>
								<span class="muted">
									{group.calls.length} invocations · {group.retryCount} retr{group.retryCount === 1 ? 'y' : 'ies'}{group.hasError
										? ' · includes error'
										: ''}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="summary-col">
				<h4>Markers ({detail.markers.length})</h4>
				{#if detail.markers.length === 0}
					<p class="empty">No compaction or removed-content markers.</p>
				{:else}
					<ul class="markers">
						{#each detail.markers as marker, index (marker.type + index)}
							<li>
								<span class={`ui-badge ui-badge--${marker.type}`}>{marker.type}</span>
								<span class="muted">
									{marker.type === 'compaction'
										? marker.at === null
											? 'context summarization point'
											: `context summarization at ${formatClock(marker.at)}`
										: 'removed content (no timestamp)'}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			{#if ziptaskEnabled}
				<div class="summary-col">
					<h4>Tracker links <span class="muted">(inferred)</span></h4>
					{#if trackerRefs.length === 0}
						<p class="empty">No tracker link.</p>
					{:else if refBase === null}
						<p class="empty">ZIPTASK_BASE_URL is not configured.</p>
					{:else}
						<ul class="chips">
							{#each trackerRefs as ref (ref)}
								<li>
									<button type="button" class="ui-chip ui-chip--link" onclick={() => onOpenTask?.(ref)}>
										Task #{ref}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
			<div class="summary-col">
				<h4>Permissions ({permissionRows.length})</h4>
				{#if permissionRows.length === 0}
					<p class="empty">No permission prompts recorded.</p>
				{:else}
					<ul class="markers">
						{#each permissionRows as permission (permission.requestId)}
							<li>
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
			</div>
		</div>
	</section>

	<section class="block">
		<div class="actions-head">
			<h4>Steps &amp; actions ({stepCount} steps · {itemCount} items)</h4>
			<input
				class="ui-input search"
				type="search"
				placeholder="Filter rows…"
				aria-label="Filter steps and actions"
				bind:value={actionSearch}
			/>
		</div>
		<div class="filters" role="group" aria-label="Row type filter">
			<button
				type="button"
				class="ui-btn toggle-all"
				aria-pressed={allExpanded}
				aria-label={allExpanded ? 'Collapse all steps' : 'Expand all steps'}
				title={allExpanded ? 'Collapse all' : 'Expand all'}
				onclick={toggleAll}
			>
				<Icon name={allExpanded ? 'collapse' : 'expand'} size={14} />
			</button>
			{#each ROW_FILTERS as filter (filter.value)}
				<button
					type="button"
					class="ui-chip ui-chip--toggle filter"
					class:active={kindFilter === filter.value}
					onclick={() => (kindFilter = filter.value)}
				>
					{filter.label}
				</button>
			{/each}
			<button
				type="button"
				class="ui-chip ui-chip--toggle filter filter-perm"
				class:active={permissionOnly}
				onclick={() => (permissionOnly = !permissionOnly)}
			>
				Permission
			</button>
		</div>
		{#if !hasContent}
			<p class="empty">No steps or actions recorded for this node.</p>
		{:else if visibleRows.length === 0}
			<p class="empty">No rows match the current filter.</p>
		{:else}
			<div class="table-scroll">
				<ScrollView orientation="horizontal">
				<table>
					<thead>
						<tr>
							<th scope="col" class="col-num">#</th>
							<th scope="col" class="col-event">Event / action</th>
							<th scope="col" class="col-time">Start</th>
							<th scope="col" class="col-time">End</th>
							<th scope="col" class="col-time">Duration</th>
							{#each usageColumns as label (label)}
								<th scope="col" class="num col-token">{label}</th>
							{/each}
							<th scope="col" class="num col-cost">Cost</th>
						</tr>
					</thead>
					<tbody>
						{#each visibleRows as { row, children } (row.key)}
							{#if row.kind === 'step' && row.step && row.stepIndex !== null}
								{@const step = row.step}
								{@const summary = summarizeStepTools(
									children.filter((child) => child.kind === 'tool').map((child) => child.call!)
								)}
								{@const open = isOpen(row)}
								{@const cells = tokenBreakdown(step.usage)}
								<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
								<tr class="step-row" onclick={() => toggleRow(row.key)}>
									<td class="col-num">{row.stepIndex + 1}</td>
									<td class="col-event">
										<span class="cell-flex">
											<span class="row-icon">
												<button
													type="button"
													class="ui-icon-btn row-toggle"
													aria-expanded={open}
													aria-label={open ? 'Collapse step' : 'Expand step'}
													onclick={(event) => {
														event.stopPropagation();
														toggleRow(row.key);
													}}
												>
													<TreeIcon name="chevron" expanded={open} size={14} />
												</button>
											</span>
											<span class="step-reason" title={reasonTitle(row.stepIndex, step, summary)}>
												{step.reason ?? 'step'}
											</span>
											{#if step.open}
												<span class="ui-badge">open</span>
											{/if}
											{#if summary.count > 0}
												<span class="muted">{summary.count} tool{summary.count === 1 ? '' : 's'}</span>
											{/if}
											{#if summary.errorCount > 0}
												<span class="reason-err">· {summary.errorCount} err</span>
											{/if}
										</span>
									</td>
									<td class="mono col-time">{formatClock(step.startedAt)}</td>
									<td class="mono col-time">
										{step.endedAt === null ? 'running' : formatClock(step.endedAt)}
									</td>
									<td class="col-time">{formatDuration(step.startedAt, step.endedAt)}</td>
									{#each cells as cell (cell.label)}
										<td class="num col-token">{formatNumber(cell.value)}</td>
									{/each}
									<td class="num col-cost">{formatCost(step.usage.cost)}</td>
								</tr>
								{#each children as child (child.key)}
									<tr class={`child-row child-${child.kind}`} class:row-collapsed={!open}>
										<td class="child-mark col-num" aria-hidden="true">↳</td>
										<td class="col-event">
										<span class="cell-flex">
											{#if child.kind === 'tool' && child.call}
												{@const call = child.call}
												<span class="row-icon">
													<span class={`dot dot-${statusTone(call.status)}`}></span>
												</span>
												<button
													type="button"
													class="ui-link-btn reason-link"
													title={`${call.name} · ${call.status}`}
													aria-label={`Jump to ${call.name} call`}
													onclick={(event) => focusCall(event, call.id)}
												>
													{call.name}
												</button>
												{#if call.isMcp}<span class="ui-badge ui-badge--mcp">MCP</span>{/if}
												{#if call.isDelegation}<span class="ui-badge ui-badge--deleg">delegation</span>{/if}
												{#if call.permission}
													<span class="ui-badge ui-badge--perm"
														>ask{call.permission.reply ? `: ${call.permission.reply}` : ''}</span
													>
												{/if}
												<span class="muted">{call.status}</span>
											{:else}
												<span class="row-icon">
													<span class={`dot dot-kind-${child.kind}`}></span>
												</span>
												<button
													type="button"
													class="ui-link-btn action-link"
													title={`Jump to ${child.kind} details`}
													onclick={(event) => focusAction(event, child.actionId)}
												>
													{child.label && child.label !== child.kind ? child.label : child.kind}
												</button>
											{/if}
										</span>
									</td>
										<td class="mono col-time">{formatClock(child.at)}</td>
										<td class="mono col-time">
											{child.endedAt === null ? '—' : formatClock(child.endedAt)}
										</td>
										<td class="col-time">
											{child.endedAt === null ? '—' : formatDuration(child.at, child.endedAt)}
										</td>
										{#each usageColumns as label (label)}
											<td class="num col-token">—</td>
										{/each}
										<td class="num col-cost">—</td>
									</tr>
								{/each}
							{:else}
								<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
								<tr
									class={`marker-row marker-${row.kind}`}
									onclick={() => scrollToAction(row.actionId)}
								>
									<td class="marker-mark col-num" aria-hidden="true">
										{row.kind === 'start' ? '▶' : row.kind === 'prompt' ? '▸' : '·'}
									</td>
									<td class="col-event">
										<span class="cell-flex">
											{#if row.kind === 'start'}
												<span class="row-icon">
													<span class="dot dot-kind-start"></span>
												</span>
												<span>{displayAgent(row.label)}</span>
												{#if row.summary}<span class="muted">{row.summary}</span>{/if}
											{:else if row.kind === 'prompt'}
												<span class="row-icon">
													<span class="dot dot-kind-prompt"></span>
												</span>
												<span>prompt</span>
											{:else if row.kind === 'tool' && row.call}
												{@const call = row.call}
												<span class="row-icon">
													<span class={`dot dot-${statusTone(call.status)}`}></span>
												</span>
												<button
													type="button"
													class="ui-link-btn reason-link"
													title={`${call.name} · ${call.status}`}
													aria-label={`Jump to ${call.name} call`}
													onclick={(event) => focusCall(event, call.id)}
												>
													{call.name}
												</button>
												{#if call.isMcp}<span class="ui-badge ui-badge--mcp">MCP</span>{/if}
												{#if call.isDelegation}<span class="ui-badge ui-badge--deleg">delegation</span>{/if}
											{:else}
												<span class="row-icon">
													<span class={`dot dot-kind-${row.kind}`}></span>
												</span>
												<button
													type="button"
													class="ui-link-btn action-link"
													title={`Jump to ${row.kind} details`}
													onclick={(event) => focusAction(event, row.actionId)}
												>
													{row.label && row.label !== row.kind ? row.label : row.kind}
												</button>
											{/if}
										</span>
									</td>
									<td class="mono col-time">{formatClock(row.at)}</td>
									<td class="mono col-time">{row.endedAt === null ? '—' : formatClock(row.endedAt)}</td>
									<td class="col-time">{row.endedAt === null ? '—' : formatDuration(row.at, row.endedAt)}</td>
									{#each usageColumns as label (label)}
										<td class="num col-token">—</td>
									{/each}
									<td class="num col-cost">—</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
				</ScrollView>
			</div>
		{/if}
	</section>

	<section class="block">
		<h4>Details ({detailEntries.length})</h4>
		{#if detailEntries.length === 0}
			<p class="empty">No tool calls or actions recorded for this node.</p>
		{:else}
			<ul class="calls">
				{#each detailEntries as entry (entry.key)}
					{#if entry.kind === 'tool'}
						{@const call = entry.call}
						{@const input = truncateText(call.input, SNIPPET_LIMIT)}
						{@const output = truncateText(call.output, SNIPPET_LIMIT)}
						<li class="call" id={callDomId(call.id)}>
						<button
							type="button"
							class="ui-icon-btn copy"
							aria-label={copiedCallId === call.id ? 'Copied to clipboard' : `Copy ${call.name} call`}
							onclick={() => copyCall(call)}
						>
							{#if copiedCallId === call.id}
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
							<div class="io">
								<span class="io-label">input</span>
								<div class="io-text">
									<ScrollView>{expanded[`${call.id}:input`] ? call.input : input.text}</ScrollView>
								</div>
								{#if input.truncated}
									<button
										type="button"
										class="ui-link-btn expand"
										onclick={() => toggleExpanded(`${call.id}:input`)}
									>
										{expanded[`${call.id}:input`] ? 'Collapse input' : `Expand input (${formatNumber(input.originalLength)} chars)`}
									</button>
								{/if}
							</div>
						{/if}
						{#if call.output !== null && call.output !== ''}
							<div class="io">
								<span class="io-label">output</span>
								<div class="io-text">
									<ScrollView>{expanded[`${call.id}:output`] ? call.output : output.text}</ScrollView>
								</div>
								{#if output.truncated}
									<button
										type="button"
										class="ui-link-btn expand"
										onclick={() => toggleExpanded(`${call.id}:output`)}
									>
										{expanded[`${call.id}:output`] ? 'Collapse output' : `Expand output (${formatNumber(output.originalLength)} chars)`}
									</button>
								{/if}
							</div>
						{/if}
						</li>
					{:else}
						{@const action = entry.action}
						{@const body = truncateText(action.summary, SNIPPET_LIMIT)}
						<li class="call action-card" id={actionDomId(action.id)}>
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
								<div class="io">
									<span class="io-label">content</span>
									<div class="io-text">
										<ScrollView
											>{expanded[`${action.id}:action`] ? action.summary : body.text}</ScrollView
										>
									</div>
									{#if body.truncated}
										<button
											type="button"
											class="ui-link-btn expand"
											onclick={() => toggleExpanded(`${action.id}:action`)}
										>
											{expanded[`${action.id}:action`]
												? 'Collapse'
												: `Expand (${formatNumber(body.originalLength)} chars)`}
										</button>
									{/if}
								</div>
							{/if}
						</li>
					{/if}
				{/each}
			</ul>
		{/if}
	</section>

	<section class="block">
		<div class="raw-head">
			<h4>Raw JSON</h4>
			<button type="button" class="ui-link-btn expand" onclick={() => (showRaw = !showRaw)}>
				{showRaw ? 'Hide raw JSON' : 'Show raw JSON'}
			</button>
		</div>
		{#if showRaw}
			<div class="raw">
				<ScrollView>{JSON.stringify(detail, null, 2)}</ScrollView>
			</div>
		{/if}
	</section>
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

	.panel-head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: var(--space-3);
		border-bottom: 1px solid var(--border-weak-base);
		padding-bottom: var(--space-2);
	}

	.panel-head h3 {
		margin: 0;
		font-size: var(--font-size-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.panel-head .meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--font-size-small);
	}

	.mono {
		font-family: var(--font-family-mono);
		font-size: var(--font-size-sm);
	}

	.block {
		margin-top: var(--space-4);
	}

	.block h4 {
		margin: 0 0 var(--space-1);
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.actions-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-bottom: var(--space-1);
	}

	.actions-head h4 {
		margin: 0;
	}

	.search {
		flex: 0 1 18rem;
		min-width: 8rem;
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin-bottom: var(--space-2);
	}

	/* Single square icon button that toggles expand/collapse for all steps. */
	.toggle-all {
		padding: 0 var(--space-1);
		color: var(--text-interactive-base);
	}

	.filter.active {
		background: var(--surface-interactive-base);
		color: var(--text-strong);
		border-color: var(--border-selected);
	}

	.empty {
		color: var(--text-weak);
		font-size: var(--font-size-small);
		margin: 0;
	}

	.summary-strip {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		align-items: start;
		gap: var(--space-3) var(--space-5);
	}

	.summary-col {
		min-width: 0;
	}

	.table-scroll {
		overflow: hidden;
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
	}

	table {
		border-collapse: separate;
		border-spacing: 0;
		table-layout: fixed;
		width: 100%;
		min-width: 74rem;
		font-size: var(--font-size-sm);
		white-space: nowrap;
	}

	th,
	td {
		padding: var(--space-1) var(--space-2);
		border-bottom: 1px solid var(--border-weaker-base);
		text-align: left;
		vertical-align: middle;
	}

	th {
		color: var(--text-weak);
		font-weight: var(--font-weight-medium);
		background: var(--surface-base);
	}

	/* Fixed column widths so expanding a step never shifts the layout. */
	.col-num {
		width: 2rem;
		padding-left: var(--space-1);
		padding-right: var(--space-1);
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.col-event {
		width: 20rem;
		padding-left: var(--space-1);
	}

	.col-time {
		width: 6.5rem;
	}

	.col-token {
		width: 6rem;
	}

	.col-cost {
		width: 6rem;
	}

	/* Pin the first two columns while the token columns scroll horizontally. */
	.col-num,
	.col-event {
		position: sticky;
		z-index: 2;
		background: var(--background-strong);
	}

	.col-num {
		left: 0;
	}

	.col-event {
		left: 2rem;
		overflow: hidden;
	}

	th.col-num,
	th.col-event {
		z-index: 3;
		background: var(--surface-base);
	}

	.step-row:hover .col-num,
	.step-row:hover .col-event {
		background: var(--surface-raised-base-hover);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.reason-err {
		margin-left: var(--space-1);
		color: var(--color-danger-strong);
	}

	.calls,
	.retries,
	.markers,
	.chips {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.calls {
		display: grid;
		gap: var(--space-2);
	}

	.call {
		position: relative;
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
		padding: var(--space-2) var(--space-3);
		background: var(--surface-base);
	}

	.call-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--font-size-small);
		padding-right: var(--space-8);
	}

	.step-row {
		cursor: pointer;
	}

	.step-row:hover {
		background: var(--surface-raised-base-hover);
	}

	.child-row.row-collapsed {
		display: none;
	}

	/* Inner flex wrapper: keeps the <td> a real table-cell (so its bottom
	   border spans the column) while aligning the row's contents. */
	.cell-flex {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	/* Uniform leading-icon slot so the expand chevron and the child dots
	   share one column and every label starts at the same x. */
	.row-icon {
		flex: 0 0 var(--space-6);
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	/* The chevron is a control, not a button-shaped target: no own hover fill. */
	.row-toggle:hover:not(:disabled) {
		background: transparent;
	}

	.child-mark,
	.marker-mark {
		color: var(--text-weak);
	}

	.marker-row {
		color: var(--text-weak);
	}

	.marker-row .ui-badge {
		font-size: var(--font-size-xs);
	}

	.row-toggle {
		vertical-align: middle;
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

	.dot-ok {
		background: var(--color-success-base);
	}
	.dot-err {
		background: var(--color-danger-base);
	}
	.dot-run {
		background: var(--color-warning-base);
	}
	.dot-other {
		background: var(--icon-base);
	}

	/* Action-kind dots, mirroring the Details badge palette. */
	.dot-kind-text,
	.dot-kind-file,
	.dot-kind-prompt {
		background: var(--color-accent-base);
	}
	.dot-kind-reasoning,
	.dot-kind-agent {
		background: var(--color-info-base);
	}
	.dot-kind-patch {
		background: var(--color-success-base);
	}
	.dot-kind-compaction {
		background: var(--text-weak);
	}
	.dot-kind-start {
		background: var(--icon-base);
	}

	.name {
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.error {
		color: var(--color-danger-strong);
		font-size: var(--font-size-sm);
		margin: var(--space-1) 0 0;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.io {
		margin-top: var(--space-1);
	}

	.io-label {
		color: var(--text-weak);
		font-size: var(--font-size-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.io-text,
	.raw {
		display: flex;
		flex-direction: column;
		margin: var(--space-1) 0 0;
		padding: var(--space-2);
		background: var(--background-strong);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
		font-family: var(--font-family-mono);
		font-size: var(--font-size-sm);
		color: var(--text-base);
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 16rem;
		overflow: hidden;
	}

	.raw {
		max-height: 28rem;
		margin-top: var(--space-2);
	}

	.raw-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.raw-head h4 {
		margin: 0;
	}

	.retries,
	.markers {
		display: grid;
		gap: var(--space-1);
		font-size: var(--font-size-small);
	}

	.retries li {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: baseline;
	}

	.retries li.has-error .name {
		color: var(--color-danger-strong);
	}

	.markers li {
		display: flex;
		gap: var(--space-2);
		align-items: baseline;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		font-size: var(--font-size-small);
	}
</style>
