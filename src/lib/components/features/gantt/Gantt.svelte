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
	import { formatClock, formatCost, formatDuration } from '$lib/model/format';
	import { selectNodeDetail } from '$lib/model/node';
	import GanttChart from './GanttChart.svelte';
	import GanttCursor from './GanttCursor.svelte';
	import GanttEdges, { type ConnectorView, type MarkerEdgeView } from './GanttEdges.svelte';
	import GanttHeader from './GanttHeader.svelte';
	import GanttLabels from './GanttLabels.svelte';
	import GanttLegend from './GanttLegend.svelte';
	import GanttNodeRow from './GanttNodeRow.svelte';
	import NodeDetailPanel from '$lib/components/features/node-detail/NodeDetailPanel.svelte';
	import ScrollView from '$lib/components/primitives/ScrollView.svelte';
	import TaskModal from '$lib/components/features/tracker/TaskModal.svelte';
	import {
		buildTicks,
		computeTimeScale,
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
	// Cursor slice for `GanttCursor`: null exactly while the pointer is outside
	// the chart band (both states clear together).
	const cursorView = $derived(
		cursorX === null || cursorT === null ? null : { x: cursorX, label: cursorLabel }
	);

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
	// Precomputed axis-tick slice for the SVG shell: the root owns `x()` and
	// `tickAnchor()`, so `GanttChart` only renders the mapped positions.
	const tickViews = $derived(
		ticks.map((t) => ({ t, x: x(t), anchor: tickAnchor(x(t)), label: formatClock(t) }))
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
	function edgeColor(edge: Edge): string {
		if (edge.running) return 'var(--color-warning-base)';
		if (edge.status === 'error' || edge.flags.includes('noChild')) return 'var(--color-danger-base)';
		if (edge.status === 'completed') return 'var(--color-success-base)';
		return 'var(--text-weak)';
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
	// `ConnectorView` / `MarkerEdgeView` are declared in `GanttEdges.svelte`
	// (the renderer) so both sides share one shape.

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

<section class="gantt">
	<GanttHeader
		{turnIndex}
		rootSessionId={model.rootSessionId}
		usage={turnUsage}
		{extent}
	/>

	<div class="layout">
		<div class="main-col">
			<div class="scroll">
		<ScrollView orientation="horizontal" bind:viewportWidth={scrollWidth}>
		<div class="inner">
			<GanttLabels
				rows={rowViews}
				rowHeight={ROW_H}
				axisHeight={AXIS_H}
				{refBase}
				{expandedRefs}
				bind:labelWidth
				onSelect={selectNode}
				onHover={(nodeId) => (hoveredNodeId = nodeId)}
				onToggleRefs={toggleRefs}
				onOpenTask={openTask}
			/>

			<GanttChart
				rows={rowViews}
				ticks={tickViews}
				{chartWidth}
				{chartHeight}
				axisHeight={AXIS_H}
				rowHeight={ROW_H}
				inset={INSET}
				{hoveredNodeId}
				{onPointerMove}
				{onPointerLeave}
				{onChartClick}
			>

				<!-- Delegation edges (task #241/#243, S-curved #255): one gray cubic
				     Bézier per edge from the parent's spawn tick into the child
				     tube's left cap, plus no-child diamond markers. The root keeps
				     `edgeLayout`, so the precomputed slices are passed down. -->
				<GanttEdges links={edgeLayout.links} markers={edgeLayout.markers} />

				<!-- Nodes (ADR 3.5c): one focusable `<g>` per row, rendered by
				     GanttNodeRow; the root keeps the layout constants and math. -->
				{#each rowViews as row (row.node.sessionId)}
					<GanttNodeRow
						{row}
						{removedAnchorX}
						barTop={BAR_TOP}
						barHeight={BAR_H}
						toolY={TOOL_Y}
						toolHeight={TOOL_H}
						removedWidth={REMOVED_W}
						onSelect={selectNode}
						onHover={(nodeId) => (hoveredNodeId = nodeId)}
						onRowKey={onRowKey}
					/>
				{/each}

				<!-- Hover time cursor (ADR 3.5d): line + clock box moved to
				     GanttCursor; the root keeps the cursor state and math. -->
				<GanttCursor
					cursor={cursorView}
					{chartWidth}
					axisHeight={AXIS_H}
					{chartHeight}
				/>
			</GanttChart>
		</div>
	</ScrollView>
	</div>

		<!-- Legend -->
		<GanttLegend />
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

</style>
