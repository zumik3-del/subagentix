<script lang="ts">
	/**
	 * Interactive wall-clock Gantt (task #190, ADR §7.2 item 2 / §7.4).
	 *
	 * Hand-rolled SVG with a linear time scale — no charting dependency. Rows
	 * are the delegation tree (orchestrator + subagents); bars are node spans,
	 * step segments are tinted by agent, tool ticks mark calls, and markers
	 * flag compaction/removed content. Clicking/Enter on a row selects it and
	 * opens the M3c {@link NodeDetailPanel} (per-step usage, tool calls,
	 * retries, markers, inferred ziptask chips, raw JSON).
	 *
	 * Imports only `$lib/model/**`, so it is safe in the client bundle.
	 */
	import type { Edge, GanttModel, Marker, Node } from '$lib/model/types';
	import { formatClock, formatCost, formatDuration, formatNumber, tokenBreakdown } from '$lib/model/format';
	import { displayAgent } from '$lib/model/agent';
	import { selectNodeDetail } from '$lib/model/node';
	import NodeDetailPanel from './NodeDetailPanel.svelte';
	import ScrollView from './ScrollView.svelte';
	import TaskModal from './TaskModal.svelte';
	import {
		buildTicks,
		computeTimeScale,
		nodeShortId,
		orderNodes,
		toolTone,
		turnExtent,
		type ToolTone
	} from '$lib/model/gantt';
	import { AGENT_FALLBACK_COLOR } from '$lib/model/agent';
	import {
		collapseTrackerRefs,
		nodeTrackerRefs,
		type CollapsedTrackerRefs
	} from '$lib/model/tracker';

	let {
		model,
		turnIndex = null,
		ziptaskEnabled = true,
		ziptaskBaseUrl = null,
		agentColors = {}
	}: {
		model: GanttModel;
		/** 1-based turn order within the session, for the header label. */
		turnIndex?: number | null;
		/** Feature toggle: when false no tracker UI renders. */
		ziptaskEnabled?: boolean;
		ziptaskBaseUrl?: string | null;
		/** Agent name -> CSS color variable, from the opencode agent md frontmatter (task #239). */
		agentColors?: Record<string, string>;
	} = $props();

	// --- Layout constants (px) -------------------------------------------------
	// `ROW_H` leaves room for the label's `who` line, one flag line and up to
	// two wrapped tracker-chip lines, so a row with >=4 chips is never clipped
	// (U1 review finding). The SVG rows share the same constant, so labels and
	// bars stay aligned.
	const AXIS_H = 44;
	const ROW_H = 72;
	const BAR_TOP = 18;
	const BAR_H = 20;
	const TOOL_Y = ROW_H - 12;
	const TOOL_H = 6;
	const REMOVED_W = 26;
	/*
	 * Horizontal inset of the plot band inside the full-width chart canvas
	 * (issue #9): the time scale, grid, axis line, bars, steps, tool ticks,
	 * markers and delegation edges all map into `[INSET, chartWidth - INSET]`,
	 * so the strip no longer hugs/clips at the table edges.
	 */
	const INSET = 16;
	/*
	 * Distance from a plot edge within which a tick label switches to an
	 * edge-anchored alignment, so first/last labels never clip at the frame.
	 */
	const TICK_EDGE = 26;

	// --- Responsive chart width ------------------------------------------------
	// The chart shares the viewport with the fixed label column, so the available
	// drawing width is the viewport minus the labels. Both are measured from the
	// DOM: the `ScrollView` viewport reports its clientWidth through the bindable
	// `viewportWidth` (task #225), the labels through `bind:clientWidth`.
	// `computeTimeScale` then fits the whole span into that width, so there is
	// never horizontal overflow to scroll — the overlay thumb stays hidden.
	// Until the measurement lands (SSR / first paint) it uses its fallback width.
	let scrollWidth = $state(0);
	let labelWidth = $state(0);
	const availableWidth = $derived(scrollWidth > 0 && labelWidth > 0 ? scrollWidth - labelWidth : 0);

	// --- Selection / hover (local; no navigation) ------------------------------
	// Selection is sticky: re-selecting the active row keeps the inspector open;
	// only picking a different row changes it.
	let selectedNodeId = $state<string | null>(null);
	let hoveredNodeId = $state<string | null>(null);
	const activeNodeId = $derived(hoveredNodeId ?? selectedNodeId);

	function selectNode(nodeId: string) {
		selectedNodeId = nodeId;
	}
	function onRowKey(event: KeyboardEvent, nodeId: string) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			selectNode(nodeId);
		}
	}

	// Drill-down panel data: sliced from the already-loaded model (no fetch).
	const selectedDetail = $derived(
		selectedNodeId === null ? null : selectNodeDetail(model, selectedNodeId)
	);

	// --- Time cursor -----------------------------------------------------------
	let cursorX = $state<number | null>(null);
	let cursorT = $state<number | null>(null);
	const cursorLabel = $derived(cursorT === null ? '' : formatClock(cursorT));

	/**
	 * Row index under a viewport-relative `y`, or `null` outside the row band
	 * (above the axis strip or below the last row). Shared by the SVG hover and
	 * click handlers so the whole chart row follows the pointer (task #229).
	 */
	function rowIndexAtY(y: number): number | null {
		if (y < AXIS_H) return null;
		const index = Math.floor((y - AXIS_H) / ROW_H);
		return index < rows.length ? index : null;
	}
	function onPointerMove(event: MouseEvent) {
		const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
		// Clamp to the inset plot band, then invert the same transform `x()` uses.
		const right = Math.max(INSET, chartWidth - INSET);
		const x = Math.max(INSET, Math.min(right, event.clientX - rect.left));
		cursorX = x;
		cursorT = extent.start + (x - INSET) / pxPerMs;
		const index = rowIndexAtY(event.clientY - rect.top);
		hoveredNodeId = index === null ? null : rows[index].sessionId;
	}
	function onPointerLeave() {
		cursorX = null;
		cursorT = null;
		hoveredNodeId = null;
	}
	function onChartClick(event: MouseEvent) {
		// A click on a node `<g>` already toggles it; ignore that bubbled click
		// so a row is never toggled twice.
		const target = event.target as Element | null;
		if (target?.closest('g.node')) return;
		const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
		const index = rowIndexAtY(event.clientY - rect.top);
		if (index === null) return;
		selectNode(rows[index].sessionId);
	}

	// --- Derived model / scale -------------------------------------------------
	const rows = $derived(orderNodes(model.nodes));
	// Auto-open the top row whenever a new model loads. `$effect` runs only in
	// the browser (SSR leaves the inspector collapsed); tracking the model
	// object — not the selection — keeps a manual row choice until the model
	// actually changes.
	let lastAutoOpenedModel: GanttModel | null = null;
	$effect(() => {
		if (model === lastAutoOpenedModel) return;
		lastAutoOpenedModel = model;
		selectedNodeId = rows[0]?.sessionId ?? null;
	});
	const extent = $derived(turnExtent(model));
	const span = $derived(Math.max(1, extent.end - extent.start));
	const scale = $derived(computeTimeScale(span, availableWidth));
	const chartWidth = $derived(scale.chartWidth);
	// Plot band: the chart canvas minus the two side insets. `computeTimeScale`
	// still supplies the fitted full `chartWidth`; the span is mapped onto the
	// inset plot width instead, so its own (uninset) `pxPerMs` is unused.
	const plotWidth = $derived(Math.max(1, chartWidth - 2 * INSET));
	const pxPerMs = $derived(plotWidth / span);
	const chartHeight = $derived(AXIS_H + rows.length * ROW_H + 12);
	// Non-positional removed markers have no timestamp; anchor them to the
	// turn's data edge (`x(extent.end)`), derived from the same scale as the bars.
	const removedAnchorX = $derived(Math.max(0, x(extent.end) - REMOVED_W - 4));
	const rowIndexById = $derived(new Map(rows.map((node, index) => [node.sessionId, index])));
	const ticks = $derived(
		buildTicks(extent.start, extent.end, Math.max(2, Math.round(chartWidth / 110)))
	);

	// --- Inferred tracker links (M4) -------------------------------------------
	// Links are only ever inferred, so every node chip is labelled as such. The
	// base URL comes from the server page prop (`ZIPTASK_BASE_URL`) with trailing
	// slashes stripped; ids are percent-encoded.
	const refBase = $derived(
		ziptaskEnabled && ziptaskBaseUrl ? ziptaskBaseUrl.replace(/\/+$/, '') : null
	);
	/** Per-node ref-list expander state, keyed by the node session id. */
	let expandedRefs = $state<Record<string, boolean>>({});
	function toggleRefs(key: string) {
		expandedRefs[key] = !expandedRefs[key];
	}
	/** Task ref whose detail modal is open, or null. */
	let activeTaskId = $state<string | null>(null);
	function openTask(ref: string) {
		activeTaskId = ref;
	}
	function closeTask() {
		activeTaskId = null;
	}

	// --- Turn totals -----------------------------------------------------------
	// Aggregate usage over the turn's nodes, shown in the header as the same
	// token breakdown as the session header plus the summed cost.
	const turnUsage = $derived(
		model.nodes.reduce(
			(acc, node) => ({
				input: acc.input + node.usage.input,
				output: acc.output + node.usage.output,
				reasoning: acc.reasoning + node.usage.reasoning,
				cacheRead: acc.cacheRead + node.usage.cacheRead,
				cacheWrite: acc.cacheWrite + node.usage.cacheWrite,
				total: acc.total + node.usage.total,
				cost: acc.cost + node.usage.cost
			}),
			{ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }
		)
	);

	function x(time: number): number {
		return INSET + (time - extent.start) * pxPerMs;
	}
	/**
	 * Edge-aware tick label alignment: the first/last label switches to
	 * `start`/`end` near the plot edges so its text stays fully inside the
	 * frame instead of clipping (issue #9).
	 */
	function tickAnchor(px: number): 'start' | 'middle' | 'end' {
		if (px - INSET < TICK_EDGE) return 'start';
		if (chartWidth - INSET - px < TICK_EDGE) return 'end';
		return 'middle';
	}
	/**
	 * Tool-tick fill from the semantic status tokens. Returned as a CSS custom
	 * property reference and applied through an inline `style` (SVG presentation
	 * attributes do not substitute `var()` reliably).
	 */
	function toolColor(tone: ToolTone): string {
		switch (tone) {
			case 'completed':
				return 'var(--color-success-base)';
			case 'error':
				return 'var(--color-danger-base)';
			case 'running':
				return 'var(--color-warning-base)';
			default:
				return 'var(--icon-base)';
		}
	}
	function edgeColor(edge: Edge): string {
		if (edge.running) return 'var(--color-warning-base)';
		if (edge.status === 'error' || edge.flags.includes('noChild')) return 'var(--color-danger-base)';
		if (edge.status === 'completed') return 'var(--color-success-base)';
		return 'var(--text-weak)';
	}
	/** ui-badge tone for a node flag key (docs/ui-standards.md §6). */
	function flagTone(key: string): 'warning' | 'danger' {
		switch (key) {
			case 'running':
			case 'end=null':
			case 'openStep':
				return 'warning';
			default:
				return 'danger';
		}
	}
	function groupByNode<T extends { nodeId: string }>(items: T[]): Map<string, T[]> {
		const groups = new Map<string, T[]>();
		for (const item of items) {
			const list = groups.get(item.nodeId);
			if (list) list.push(item);
			else groups.set(item.nodeId, [item]);
		}
		return groups;
	}

	// --- Flags -----------------------------------------------------------------
	interface FlagView {
		key: string;
		label: string;
		description: string;
	}
	const NODE_FLAG_META: Record<string, FlagView> = {
		clampedEnd: {
			key: 'clampedEnd',
			label: 'clamped',
			description: 'End was before start; clamped to start.'
		},
		futureEnd: {
			key: 'futureEnd',
			label: 'future',
			description: 'End was in the future; clamped to now.'
		},
		overlapsNextTurn: {
			key: 'overlapsNextTurn',
			label: 'overlap',
			description: 'Runs past the next turn trigger.'
		},
		multiSpawn: {
			key: 'multiSpawn',
			label: 'multi-spawn',
			description: 'More than one delegation spawned this node.'
		},
		orphanEdge: {
			key: 'orphanEdge',
			label: 'orphan edge',
			description: 'A delegation edge started before the first turn.'
		}
	};
	// --- Row view models -------------------------------------------------------
	interface StepView {
		key: string;
		x: number;
		width: number;
		open: boolean;
		title: string;
	}
	interface ToolView {
		key: string;
		x: number;
		tone: ToolTone;
		delegation: boolean;
		/** The call triggered a user permission prompt (collector). */
		permission: boolean;
		title: string;
	}
	interface MarkerView {
		key: string;
		type: Marker['type'];
		x: number | null;
		title: string;
	}
	interface RowView {
		node: Node;
		index: number;
		top: number;
		barX: number;
		barWidth: number;
		/** Agent color for this row (md `color:` or the neutral fallback). */
		agentColor: string;
		running: boolean;
		active: boolean;
		dimmed: boolean;
		flags: FlagView[];
		steps: StepView[];
		tools: ToolView[];
		markers: MarkerView[];
		/** Inferred tracker refs of this node (deduped). */
		trackerRefs: string[];
		/** Collapsed display view of {@link RowView.trackerRefs}. */
		trackerChips: CollapsedTrackerRefs;
	}

	const rowViews = $derived.by((): RowView[] => {
		const stepsByNode = groupByNode(model.steps);
		const toolsByNode = groupByNode(model.toolCalls);
		const markersByNode = groupByNode(model.markers);
		// `activeNodeId` (hover ?? selection) drives only purely visual emphasis
		// (dimming/edges); `row.active` below is selection-only so `aria-pressed`
		// and the selected styling never follow hover.
		const active = activeNodeId;
		return rows.map((node, index) => {
			const top = AXIS_H + index * ROW_H;
			const barX = x(node.startedAt);
			const barEnd = x(node.endedAt ?? extent.end);
			const barWidth = Math.max(2, barEnd - barX);
			const agentColor = agentColors[node.agent] ?? AGENT_FALLBACK_COLOR;
			const nodeMarkers = markersByNode.get(node.sessionId) ?? [];
			const removed = nodeMarkers.some((marker) => marker.type === 'removed');

			const flags: FlagView[] = [];
			if (node.running) {
				flags.push({ key: 'running', label: 'RUN', description: 'Node is still running.' });
			}
			if (node.endedAt === null) {
				flags.push({
					key: 'end=null',
					label: 'end=null',
					description: "No end timestamp; the bar reaches the turn's right edge."
				});
			}
			if (node.openStep) {
				flags.push({
					key: 'openStep',
					label: 'open step',
					description: 'A step-start has no matching step-finish.'
				});
			}
			for (const flag of node.flags) {
				const meta = NODE_FLAG_META[flag];
				if (meta && !flags.some((existing) => existing.key === meta.key)) flags.push(meta);
			}
			if (removed) {
				flags.push({
					key: 'removed',
					label: 'removed',
					description: 'Message content was removed from the DB (no timestamp).'
				});
			}

			const steps: StepView[] = (stepsByNode.get(node.sessionId) ?? []).map((step) => {
				const stepEnd = step.endedAt ?? node.endedAt ?? extent.end;
				const startX = Math.max(barX, x(step.startedAt));
				const endX = Math.min(barX + barWidth, x(stepEnd));
				return {
					key: step.id,
					x: startX,
					width: Math.max(1, endX - startX),
					open: step.open,
					title: `step ${step.index + 1} · ${step.modelId ?? 'unknown model'} · ${formatDuration(
						step.startedAt,
						step.endedAt
					)} · ${formatCost(step.usage.cost)}${step.flags.length ? ` · ${step.flags.join(', ')}` : ''}`
				};
			});

			const tools: ToolView[] = (toolsByNode.get(node.sessionId) ?? []).map((call) => ({
				key: call.id,
				x: x(call.startedAt ?? node.startedAt),
				tone: toolTone(call.status),
				delegation: call.isDelegation,
				permission: call.permission != null,
				title: `${call.name} · ${call.status}${call.error ? ` · ${call.error}` : ''} · ${formatDuration(
					call.startedAt ?? node.startedAt,
					call.endedAt
				)}${call.flags.length ? ` · ${call.flags.join(', ')}` : ''}${
					call.permission
						? ` · permission: ${call.permission.reply ?? 'pending'}`
						: ''
				}`
			}));

			const markers: MarkerView[] = nodeMarkers.map((marker, markerIndex) => ({
				key: `${marker.type}-${markerIndex}`,
				type: marker.type,
				x: marker.at === null ? null : x(marker.at),
				title:
					marker.type === 'compaction'
						? 'Compaction marker (context summarization point)'
						: 'Removed content marker (no timestamp)'
			}));

			const trackerRefs = nodeTrackerRefs(node, model.toolCalls, model.edges);
			const trackerChips = collapseTrackerRefs(trackerRefs);

			return {
				node,
				index,
				top,
				barX,
				barWidth,
				agentColor,
				running: node.running,
				active: selectedNodeId === node.sessionId,
				dimmed: active !== null && active !== node.sessionId,
				flags,
				steps,
				tools,
				markers,
				trackerRefs,
				trackerChips
			};
		});
	});

	// --- Edge view models ------------------------------------------------------
	interface ConnectorView {
		id: string;
		/** SVG path `d`: cubic Bézier from the spawn tick to the child cap. */
		path: string;
		running: boolean;
		dimmed: boolean;
		title: string;
	}
	interface MarkerEdgeView {
		id: string;
		color: string;
		active: boolean;
		dimmed: boolean;
		title: string;
		markerX: number | null;
		markerY: number | null;
	}

	/** Shared tooltip for a delegation edge (drop line or no-child marker). */
	function edgeTitle(edge: Edge): string {
		return `${edge.subagentType ?? edge.parentNodeId} → ${
			edge.childNodeId ?? 'no session'
		} · ${edge.status}${edge.error ? ` · ${edge.error}` : ''} · ${formatDuration(
			edge.startedAt ?? model.t0,
			edge.endedAt
		)}${edge.flags.length ? ` · ${edge.flags.join(', ')}` : ''}`;
	}

	/**
	 * Delegation edges (task #241, reworked #243, S-curved #255). Every edge
	 * with a parent row and a resolvable child row renders one cubic Bézier
	 * from the spawn tick on the parent row (`x(edge.startedAt)`, `TOOL_Y`
	 * centre) into the centre of the child tube's left cap. The spawn tick and
	 * the child start coincide on the time axis, so a monotone curve would be a
	 * plain vertical; the control points deliberately swing right then left to
	 * make the connection read as a smooth S. Multi-spawn is N parallel curves
	 * — no trunk or shared branches. An edge with no child row keeps the
	 * compact diamond at the parent row centre.
	 */
	const edgeLayout = $derived.by(() => {
		const active = activeNodeId;
		const links: ConnectorView[] = [];
		const markers: MarkerEdgeView[] = [];

		for (const edge of model.edges) {
			const parentIndex = rowIndexById.get(edge.parentNodeId);
			const childIndex =
				edge.childNodeId === null ? undefined : rowIndexById.get(edge.childNodeId);
			const related =
				active !== null && (edge.parentNodeId === active || edge.childNodeId === active);

			if (parentIndex !== undefined && childIndex !== undefined) {
				const parentTop = AXIS_H + parentIndex * ROW_H;
				const childTop = AXIS_H + childIndex * ROW_H;
				// Start at the spawn tick when known, else fall back to the child's
				// own start so the curve never collapses.
				const sx = edge.startedAt === null ? x(rows[childIndex].startedAt) : x(edge.startedAt);
				const sy = parentTop + TOOL_Y + TOOL_H / 2;
				// End at the vertical centre of the child tube's left cap
				// (`barX` in the row view = x(node.startedAt)`).
				const ex = x(rows[childIndex].startedAt);
				const ey = childTop + BAR_TOP + BAR_H / 2;
				// Symmetric S: swing right on departure, arrive from the left into
				// the cap. `a` scales with the row gap but is clamped so short and
				// long drops stay readable. The spawn/child x usually coincide, so
				// this fixed amplitude is what makes the curve visible at all.
				const dy = ey - sy;
				const a = Math.min(Math.max(dy * 0.3, 12), 34);
				links.push({
					id: edge.id,
					path: `M ${sx} ${sy} C ${sx + a} ${sy + dy * 0.33}, ${ex - a} ${ey}, ${ex} ${ey}`,
					running: edge.running,
					dimmed: active !== null && !related,
					title: edgeTitle(edge)
				});
				continue;
			}

			// No child row (failed spawn or child outside the turn): keep the
			// existing diamond marker at the parent row centre.
			const parentTop = parentIndex === undefined ? 0 : AXIS_H + parentIndex * ROW_H;
			markers.push({
				id: edge.id,
				color: edgeColor(edge),
				active: related,
				dimmed: active !== null && !related,
				title: edgeTitle(edge),
				markerX: edge.startedAt === null ? null : x(edge.startedAt),
				markerY: parentIndex === undefined ? null : parentTop + ROW_H / 2
			});
		}

		return { links, markers };
	});
</script>

{#snippet trackerChipList(
	refs: string[],
	chips: CollapsedTrackerRefs,
	expanded: boolean,
	onToggle: () => void
)}
	{#each refs as ref (ref)}
		{#if refBase === null}
			<span
				class="ui-chip"
				title={`Task #${ref} (inferred tracker link)`}
				aria-label={`Task #${ref} (inferred tracker link)`}>{`#${ref}`}</span
			>
		{:else}
			<button
				type="button"
				class="ui-chip ui-chip--link"
				title={`Task #${ref} (inferred tracker link)`}
				aria-label={`Task #${ref} (inferred tracker link)`}
				onclick={() => openTask(ref)}>{`#${ref}`}</button
			>
		{/if}
	{/each}
	{#if chips.hiddenCount > 0}
		<button
			type="button"
			class="ui-chip ui-chip--toggle"
			onclick={onToggle}
			title="Show all inferred tracker links"
		>
			{expanded ? 'Show fewer' : chips.expanderLabel}
		</button>
	{/if}
{/snippet}

<section class="gantt">
	<header class="head">
		<div class="head-main">
			<p class="turn-title">
				Turn {turnIndex ?? '—'}
				<span class="turn-sid">({nodeShortId(model.rootSessionId)})</span>
			</p>
			<ul class="tokens">
				{#each tokenBreakdown(turnUsage) as token (token.label)}
					<li><span class="muted">{token.label}</span> {formatNumber(token.value)}</li>
				{/each}
				<li class="cost" title="Cost (gross)">{formatCost(turnUsage.cost)}</li>
			</ul>
		</div>
		<div class="timing">
			<span class="time-range">
				{formatClock(extent.start)} → {formatClock(extent.end)}
			</span>
			<span class="duration">{formatDuration(extent.start, extent.end)}</span>
		</div>
	</header>

	<div class="layout">
		<div class="main-col">
			<div class="scroll">
		<ScrollView orientation="horizontal" bind:viewportWidth={scrollWidth}>
		<div class="inner">
			<div
				class="labels"
				bind:clientWidth={labelWidth}
				style={`--row-h:${ROW_H}px;--axis-h:${AXIS_H}px`}
			>
				<div class="axis-spacer">Node</div>
				{#each rowViews as row (row.node.sessionId)}
					{@const nodeRefs = expandedRefs[row.node.sessionId]
						? [...row.trackerChips.visible, ...row.trackerChips.hidden]
						: row.trackerChips.visible}
					<div
						class="label"
						class:active={row.active}
						class:dimmed={row.dimmed}
					>
						<button
							type="button"
							class="label-btn"
							aria-pressed={row.active}
							onclick={() => selectNode(row.node.sessionId)}
							onmouseenter={() => (hoveredNodeId = row.node.sessionId)}
							onmouseleave={() => (hoveredNodeId = null)}
							title={`${displayAgent(row.node.agent)} · ${row.node.sessionId} · ${row.node.status}`}
						>
							<span class="who">
								<span class="ui-swatch" style={`background:${row.agentColor}`}></span>
								<span class="agent">{displayAgent(row.node.agent)}</span>
							</span>
							{#if row.node.modelId}
								<span class="model">{row.node.modelId}</span>
							{/if}
							{#if row.flags.length}
								<span class="flags">
									{#each row.flags as flag (flag.key)}
										<span class={`ui-badge ui-badge--${flagTone(flag.key)}`} title={flag.description}>{flag.label}</span>
									{/each}
								</span>
							{/if}
						</button>
						{#if row.trackerRefs.length}
							<span class="refs node-refs">
								{@render trackerChipList(
									nodeRefs,
									row.trackerChips,
									expandedRefs[row.node.sessionId] ?? false,
									() => toggleRefs(row.node.sessionId)
								)}
							</span>
						{/if}
					</div>
				{/each}
			</div>

			<!--
				Pointer-only row hit area (task #229, issue #4): the keyboard path is
				the focusable `g.node` buttons inside, so the SVG click only extends
				the same selection to the empty parts of a chart row.
			-->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<svg
				class="chart"
				width={chartWidth}
				height={chartHeight}
				viewBox={`0 0 ${chartWidth} ${chartHeight}`}
				role="img"
				aria-label="Turn wall-clock Gantt"
				onmousemove={onPointerMove}
				onmouseleave={onPointerLeave}
				onclick={onChartClick}
			>
				<defs>
					<pattern
						id="removed-hatch"
						width="6"
						height="6"
						patternUnits="userSpaceOnUse"
						patternTransform="rotate(45)"
					>
						<rect class="hatch-removed-bg" width="6" height="6" />
						<line class="hatch-removed-fg" x1="0" y1="0" x2="0" y2="6" stroke-width="2" />
					</pattern>
					<pattern
						id="running-hatch"
						width="6"
						height="6"
						patternUnits="userSpaceOnUse"
						patternTransform="rotate(45)"
					>
						<rect class="hatch-running-bg" width="6" height="6" />
						<line class="hatch-running-fg" x1="0" y1="0" x2="0" y2="6" stroke-width="2" />
					</pattern>
				</defs>

				<!-- Axis header band: a full-width strip behind the time scale, on a
				     slightly distinct token so the scale has its own header without
				     breaking the canvas seam (issue #9). -->
				<rect class="axis-band" x="0" y="0" width={chartWidth} height={AXIS_H} />
				<line class="axis-band-border" x1="0" y1={AXIS_H} x2={chartWidth} y2={AXIS_H} />

				<!-- Row backgrounds + hairlines (issue #8): one uniform canvas, no
				     zebra. Hover/selection come from the state-driven classes; the
				     1px hairline mirrors `.label`'s border-bottom so rows stay aligned
				     across the label/chart seam. -->
				{#each rowViews as row (row.node.sessionId)}
					<rect
						class="row-bg"
						class:hovered={hoveredNodeId === row.node.sessionId}
						class:active={row.active}
						x="0"
						y={row.top}
						width={chartWidth}
						height={ROW_H}
						pointer-events="none"
					/>
					{#if row.active}
						<rect
							class="row-accent"
							x={chartWidth - 2}
							y={row.top}
							width="2"
							height={ROW_H}
							pointer-events="none"
						/>
					{/if}
				{/each}
				{#each rowViews as row (row.node.sessionId)}
					<line
						class="row-hairline"
						x1="0"
						y1={row.top + ROW_H}
						x2={chartWidth}
						y2={row.top + ROW_H}
					/>
				{/each}

				<!-- Grid + shared time axis (inset plot band) -->
				{#each ticks as tick (tick)}
					<line class="grid-line" x1={x(tick)} y1={AXIS_H} x2={x(tick)} y2={chartHeight} />
					<line class="axis-tick" x1={x(tick)} y1={AXIS_H - 5} x2={x(tick)} y2={AXIS_H} />
					<text x={x(tick)} y={AXIS_H - 10} class="tick" text-anchor={tickAnchor(x(tick))}>
						{formatClock(tick)}
					</text>
				{/each}
				<line class="axis-line" x1={INSET} y1={AXIS_H} x2={chartWidth - INSET} y2={AXIS_H} />

				<!-- Delegation edges (task #241/#243, S-curved #255): one gray cubic
				     Bézier per edge from the parent's spawn tick into the child
				     tube's left cap, plus no-child diamond markers. -->
				{#each edgeLayout.links as edge (edge.id)}
					<g class="edge" opacity={edge.dimmed ? 0.25 : 0.9}>
						<path
							d={edge.path}
							fill="none"
							style="stroke:var(--icon-base)"
							stroke-width="1"
							stroke-linecap="round"
							stroke-dasharray={edge.running ? '4 3' : undefined}
						/>
						<title>{edge.title}</title>
					</g>
				{/each}

				{#each edgeLayout.markers as edge (edge.id)}
					<g class="edge" opacity={edge.dimmed ? 0.25 : 0.9}>
						{#if edge.markerX !== null && edge.markerY !== null}
							<polygon
								points={`${edge.markerX},${edge.markerY - 5} ${edge.markerX + 5},${edge.markerY} ${edge.markerX},${edge.markerY + 5} ${edge.markerX - 5},${edge.markerY}`}
								style={`fill:${edge.color}`}
							/>
						{/if}
						<title>{edge.title}</title>
					</g>
				{/each}

				<!-- Nodes -->
				{#each rowViews as row (row.node.sessionId)}
					<g
						class="node"
						class:active={row.active}
						style={`--agent:${row.agentColor}`}
						aria-pressed={row.active}
						opacity={row.dimmed ? 0.35 : 1}
						role="button"
						tabindex="0"
						aria-label={`${displayAgent(row.node.agent)} node ${nodeShortId(row.node.sessionId)}`}
						onclick={() => selectNode(row.node.sessionId)}
						onkeydown={(event) => onRowKey(event, row.node.sessionId)}
						onmouseenter={() => (hoveredNodeId = row.node.sessionId)}
						onmouseleave={() => (hoveredNodeId = null)}
					>
						<!-- Node span tube (task #239/#253): tinted by the row's agent
						     color, thin. The x/y/width/height/rx="3" order and the
						     `fill="url(#running-hatch)"` presentation attribute are parsed by
						     the SSR tests and must stay. -->
						<rect
							x={row.barX}
							y={row.top + BAR_TOP}
							width={row.barWidth}
							height={BAR_H}
							rx="3"
							fill={row.running ? 'url(#running-hatch)' : undefined}
							class="bar"
							class:bar-running={row.running}
						>
							<title>
								{`${displayAgent(row.node.agent)} · ${row.node.sessionId} · ${row.node.status} · ${formatDuration(
									row.node.startedAt,
									row.node.endedAt
								)} · ${formatCost(row.node.usage.cost)}${
									row.node.flags.length ? ` · ${row.node.flags.join(', ')}` : ''
								}`}
							</title>
						</rect>

						<!-- Step segments -->
						{#each row.steps as step (step.key)}
							<rect
								class="step"
								class:step-open={step.open}
								x={step.x}
								y={row.top + BAR_TOP + 2}
								width={step.width}
								height={BAR_H - 4}
								opacity={step.open ? 0.45 : 0.95}
								stroke-dasharray={step.open ? '3 2' : undefined}
							>
								<title>{step.title}</title>
							</rect>
						{/each}

						<!-- Tool ticks -->
						{#each row.tools as tool (tool.key)}
							<rect
								class="tool"
								class:delegation={tool.delegation}
								x={tool.x - 1.5}
								y={row.top + TOOL_Y}
								width={tool.delegation ? 5 : 3}
								height={TOOL_H}
								rx="1"
								style={`fill:${toolColor(tool.tone)}`}
							>
								<title>{tool.title}</title>
							</rect>
							{#if tool.permission}
								<circle class="tool-permission" cx={tool.x} cy={row.top + TOOL_Y - 3.5} r="2.6">
									<title>Permission requested for {tool.title}</title>
								</circle>
							{/if}
						{/each}

						<!-- Positional markers (compaction) -->
						{#each row.markers as marker (marker.key)}
							{#if marker.x !== null}
								<polygon
									class="marker"
									points={`${marker.x},${row.top + BAR_TOP - 2} ${marker.x + 5},${
										row.top + BAR_TOP + BAR_H / 2
									} ${marker.x},${row.top + BAR_TOP + BAR_H + 2} ${marker.x - 5},${
										row.top + BAR_TOP + BAR_H / 2
									}`}
									style={`fill:${marker.type === 'compaction' ? 'var(--text-strong)' : 'var(--color-danger-base)'}`}
								>
									<title>{marker.title}</title>
								</polygon>
							{/if}
						{/each}

						<!-- Removed marker: no timestamp -> non-positional; anchored to the turn's data edge -->
						{#each row.markers.filter((marker) => marker.x === null) as marker (marker.key)}
							<rect
								x={removedAnchorX}
								y={row.top + BAR_TOP}
								width={REMOVED_W}
								height={BAR_H}
								rx="3"
								fill="url(#removed-hatch)"
								class="removed"
							>
								<title>{marker.title}</title>
							</rect>
						{/each}
					</g>
				{/each}

				<!-- Hover time cursor -->
				{#if cursorX !== null && cursorT !== null}
					<line
						class="cursor-line"
						x1={cursorX}
						y1={AXIS_H}
						x2={cursorX}
						y2={chartHeight}
						pointer-events="none"
					/>
					<g pointer-events="none">
						<rect
							class="cursor-box"
							x={Math.min(cursorX + 6, chartWidth - 74)}
							y={AXIS_H + 4}
							width="70"
							height="16"
							rx="3"
						/>
						<text
							x={Math.min(cursorX + 6, chartWidth - 74) + 35}
							y={AXIS_H + 15}
							class="cursor-label"
							text-anchor="middle">{cursorLabel}</text
						>
					</g>
				{/if}
			</svg>
		</div>
	</ScrollView>
	</div>

		<!-- Legend -->
		<div class="legend">
			<div class="legend-group">
				<span class="legend-title">Tools</span>
				<span class="legend-item"><span class="tick tick-completed"></span>completed</span>
				<span class="legend-item"><span class="tick tick-error"></span>error</span>
				<span class="legend-item"><span class="tick tick-running"></span>running</span>
				<span class="legend-item"><span class="tick tick-other"></span>other</span>
				<span class="legend-item"><span class="tick tick-delegation"></span>delegation</span>
				<span class="legend-item"><span class="perm-ring"></span>permission asked</span>
			</div>
			<div class="legend-group">
				<span class="legend-title">Markers</span>
				<span class="legend-item"><span class="diamond"></span>compaction</span>
				<span class="legend-item"><span class="removed-chip"></span>removed (no timestamp)</span>
				<span class="legend-item"><span class="running-chip"></span>running span</span>
			</div>
		</div>
		</div>

		{#if selectedDetail}
			<aside class="side-col" aria-label="Node inspector">
				<NodeDetailPanel
					detail={selectedDetail}
					{ziptaskEnabled}
					{ziptaskBaseUrl}
					onOpenTask={openTask}
				/>
			</aside>
		{/if}
	</div>

	{#if activeTaskId !== null}
		<TaskModal id={activeTaskId} onClose={closeTask} />
	{/if}
</section>

<style>
	.gantt {
		margin-top: 0;
		/*
		 * Running hatch on the dark chart: a dark amber base (not the near-white
		 * `--surface-warning-weak`) so the amber stripes stay legible against the
		 * `--background-strong` canvas. Shared by the SVG pattern and the legend.
		 */
		--running-hatch-bg: color-mix(in srgb, var(--color-warning-base) 25%, var(--background-strong));
	}

	/* Same card surface as the session header (docs/ui-standards.md). */
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--space-2) var(--space-4);
		flex-wrap: wrap;
		background: var(--background-strong);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-lg);
		padding: var(--space-4);
		margin-bottom: var(--space-4);
	}

	.head-main {
		min-width: 0;
	}

	.turn-title {
		margin: 0;
		font-size: var(--font-size-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.turn-sid {
		color: var(--text-weak);
		font-weight: normal;
	}

	.tokens {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		list-style: none;
		margin: var(--space-1) 0 0;
		padding: 0;
		font-size: var(--font-size-small);
	}

	.tokens li {
		font-variant-numeric: tabular-nums;
	}

	.tokens .cost {
		color: var(--text-strong);
	}

	/* Time block: pinned to the header's top-right and stacked (docs/ui-standards.md). */
	.timing {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		flex: 0 0 auto;
		gap: var(--space-1);
		text-align: right;
		white-space: nowrap;
		font-size: var(--font-size-small);
		font-variant-numeric: tabular-nums;
		color: var(--text-weak);
	}

	.timing .time-range {
		color: var(--text-strong);
	}

	/*
	 * Chart and inspector stack in a single column (task #215): the inspector
	 * renders full-width directly below the chart/legend, never beside it.
	 */
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-4);
		align-items: start;
	}

	.main-col,
	.side-col {
		min-width: 0;
	}

	/*
	 * Styled frame for the chart; the fitted chart is exactly
	 * `viewport - labels` wide, so it never overflows. Scrolling lives in the
	 * inner `ScrollView` viewport (task #225), whose overlay thumb hides when
	 * there is nothing to scroll; `overflow: hidden` here keeps the rounded
	 * corners clipping.
	 */
	.scroll {
		overflow: hidden;
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-lg);
		/* One uniform canvas token for the whole Gantt block (issue #8). */
		background: var(--background-strong);
	}

	.inner {
		display: flex;
		align-items: flex-start;
		min-width: min-content;
	}

	.labels {
		position: sticky;
		left: 0;
		z-index: 2;
		flex: 0 0 16rem;
		width: 16rem;
		/*
		 * Same canvas as `.chart` (task #229, issue #3): the label column and the
		 * chart share `--background-strong`, so each row reads as one continuous
		 * band with no background seam at the column boundary.
		 */
		background: var(--background-strong);
		/*
		 * Layout-neutral separator: `border-right` would widen the border-box
		 * while `bind:clientWidth` (used for the fitted chart) excludes it,
		 * leaving the chart 1px too wide. A 1px outer shadow draws the same
		 * divider without affecting the measured width.
		 */
		box-shadow: 1px 0 0 var(--border-weak-base);
	}

	.axis-spacer {
		height: var(--axis-h);
		display: flex;
		align-items: flex-end;
		padding: 0 var(--space-2) var(--space-2);
		font-size: var(--font-size-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-weak);
		/* Own header band (issue #9): mirrors the SVG axis band + its bottom
		   border so the seam between label column and chart is invisible. */
		background: var(--background-stronger);
		border-bottom: 1px solid var(--border-weak-base);
	}

	.label {
		display: flex;
		flex-direction: row;
		/*
		 * Node info (agent + model + flags) is pinned to the top-left; the
		 * tracker chips are pinned to the top-right. Stretch keeps the button
		 * filling the full row height (task #229, issue #4) while both children
		 * align their content to the top.
		 */
		align-items: stretch;
		width: 100%;
		height: var(--row-h);
		border-bottom: 1px solid var(--border-weaker-base);
		overflow: hidden;
	}

	/* No zebra (issue #8): hover is a subtle band, selection a stronger one. */
	.label:hover {
		background: var(--surface-interactive-weak);
	}

	.label.active {
		background: var(--surface-interactive-base);
		box-shadow: inset 2px 0 0 var(--border-selected);
	}

	.label.dimmed {
		opacity: 0.5;
	}

	.label-btn {
		display: flex;
		flex-direction: column;
		/* Top-left stack: agent name, then model, then flags. */
		justify-content: flex-start;
		gap: var(--space-1);
		width: 100%;
		/*
		 * Fill the whole row (task #229, issue #4): `flex: 1` stretches the button
		 * over every pixel left after the tracker-chip strip, and dropping the old
		 * negative margin / padding means the hit area reaches the row edges
		 * instead of stopping at the text. The horizontal padding stays on the
		 * button so the text keeps its inline inset.
		 */
		flex: 1;
		min-width: 0;
		padding: var(--space-1) var(--space-2);
		background: none;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--text-strong);
		font: inherit;
		font-size: var(--font-size-small);
		text-align: left;
		cursor: pointer;
	}

	.label-btn:focus-visible {
		outline-offset: -2px;
	}

	.who {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		min-width: 0;
	}

	.agent {
		font-weight: var(--font-weight-medium);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.model {
		color: var(--text-weak);
		font-size: var(--font-size-xs);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.flags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}

	.refs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1);
	}

	.node-refs {
		/* Sibling of the row button, pinned to the top-right: `align-self`
		   overrides `.label`'s stretch so the chip block hugs the row top. */
		flex: 0 0 auto;
		align-self: flex-start;
		padding: var(--space-1) var(--space-2) 0;
	}

	.chart {
		display: block;
		flex: 0 0 auto;
		background: var(--background-strong);
	}

	/*
	 * SVG presentation colors. Static colors live in these classes (tokens);
	 * per-status colors are applied via inline `style` in the markup,
	 * because presentation attributes do not substitute `var()` reliably.
	 */
	/* Axis header band (issue #9): distinct top strip + full-width bottom edge. */
	.axis-band {
		fill: var(--background-stronger);
	}

	.axis-band-border {
		stroke: var(--border-weak-base);
	}

	/* Row hover/selection bands: uniform canvas, no zebra (issue #8). */
	.row-bg {
		fill: transparent;
	}

	.row-bg.hovered {
		fill: var(--surface-interactive-weak);
	}

	.row-bg.active {
		fill: var(--surface-interactive-base);
	}

	.row-accent {
		fill: var(--border-selected);
	}

	/* 1px per-row hairline mirrors `.label`'s border-bottom for row alignment. */
	.row-hairline {
		stroke: var(--border-weaker-base);
		stroke-width: 1;
	}

	.grid-line {
		stroke: var(--border-weaker-base);
	}

	.axis-tick,
	.axis-line {
		stroke: var(--border-weak-base);
	}

	.tick {
		fill: var(--text-weak);
		font-size: var(--font-size-xs);
	}

	/*
	 * Node tube (task #239, thinned #243, agent-tinted #253): the tube and its
	 * step segments both derive from `--agent` (set on the row's `<g>`), so a
	 * delegation row reads in its subagent's color. Selection, focus and hover
	 * never change the border (task #245): a gray or thickened outline on
	 * selection reads as a fat border against the near-canvas stroke. The
	 * running pattern is set through the rect's `fill` presentation attribute
	 * (patterns are not custom properties), mirrored here so this class rule
	 * does not wash it out.
	 */
	.bar {
		fill: color-mix(in srgb, var(--agent) 30%, var(--background-strong));
		stroke: color-mix(in srgb, var(--agent) 65%, var(--background-strong));
		stroke-width: 0.75;
	}

	.bar.bar-running {
		fill: url(#running-hatch);
	}

	.step {
		/* A stronger shade of the tube's agent tint so steps read as sub-segments. */
		fill: color-mix(in srgb, var(--agent) 55%, var(--background-strong));
		stroke: var(--background-base);
		stroke-width: 1;
	}

	.step.step-open {
		stroke: var(--color-warning-base);
	}

	.tool.delegation {
		stroke: var(--text-strong);
		stroke-width: 0.75;
	}

	.tool-permission {
		fill: none;
		stroke: var(--color-warning-base);
		stroke-width: 1.2;
	}

	.perm-ring {
		display: block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		border: 1.5px solid var(--color-warning-base);
	}

	.marker {
		stroke: var(--background-base);
		stroke-width: 1;
	}

	.removed {
		stroke: var(--color-danger-base);
		stroke-width: 1;
	}

	.cursor-line {
		stroke: var(--border-selected);
		stroke-width: 1;
	}

	.cursor-box {
		fill: var(--surface-float-base);
		stroke: var(--border-selected);
	}

	.cursor-label {
		fill: var(--text-strong);
		font-size: var(--font-size-xs);
	}

	.hatch-removed-bg {
		fill: var(--surface-critical-base);
	}

	.hatch-removed-fg {
		stroke: var(--color-danger-strong);
	}

	.hatch-running-bg {
		fill: var(--running-hatch-bg);
	}

	.hatch-running-fg {
		stroke: var(--color-warning-base);
	}

	.node {
		cursor: pointer;
	}

	.node:focus-visible {
		outline: 2px solid var(--border-selected);
		outline-offset: 2px;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: var(--space-5);
		margin-top: var(--space-3);
		font-size: var(--font-size-small);
	}

	.legend-group {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.legend-title {
		color: var(--text-weak);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-size: var(--font-size-xs);
		line-height: 1.2;
	}

	.legend-item {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		line-height: 1.2;
		color: var(--text-base);
	}

	.legend .tick {
		display: block;
		width: 4px;
		height: 10px;
		border-radius: 1px;
	}

	.legend .tick-completed {
		background: var(--color-success-base);
	}

	.legend .tick-error {
		background: var(--color-danger-base);
	}

	.legend .tick-running {
		background: var(--color-warning-base);
	}

	.legend .tick-other {
		background: var(--icon-base);
	}

	.legend .tick-delegation {
		width: 7px;
		background: var(--surface-strong);
		border: 1px solid var(--text-strong);
	}

	.diamond {
		display: block;
		width: 8px;
		height: 8px;
		background: var(--text-strong);
		transform: rotate(45deg);
	}

	.removed-chip {
		display: block;
		width: 14px;
		height: 9px;
		border-radius: 2px;
		background: repeating-linear-gradient(
			45deg,
			var(--surface-critical-strong),
			var(--surface-critical-strong) 3px,
			var(--color-danger-strong) 3px,
			var(--color-danger-strong) 4px
		);
	}

	.running-chip {
		display: block;
		width: 14px;
		height: 9px;
		border-radius: 2px;
		border: 1px solid var(--color-warning-base);
		background: repeating-linear-gradient(
			45deg,
			var(--running-hatch-bg),
			var(--running-hatch-bg) 3px,
			var(--color-warning-base) 3px,
			var(--color-warning-base) 4px
		);
	}
</style>
