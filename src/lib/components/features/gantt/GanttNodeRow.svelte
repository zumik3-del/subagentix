<script lang="ts">
	/**
	 * One node row of the wall-clock Gantt (extracted from `Gantt`, ADR 3.5c).
	 *
	 * Renders the focusable node `<g>`: the agent-tinted span tube, its step
	 * segments, tool ticks (with permission rings) and the compaction/removed
	 * markers. Pure presentation: the `Gantt` root keeps every positioning
	 * decision — `x()`, `barX`, `barWidth`, `removedAnchorX` and the layout
	 * constants — and passes the precomputed row slice down, so this component
	 * owns no data or position math.
	 */
	import type { Marker, Node } from '$lib/model/types';
	import { formatCost, formatDuration } from '$lib/model/format';
	import { displayAgent } from '$lib/model/agent';
	import { nodeShortId, type ToolTone } from '$lib/model/gantt';

	/** Tool-tick slice: the root maps the call to x/tone, this only renders it. */
	interface NodeToolView {
		key: string;
		x: number;
		tone: ToolTone;
		delegation: boolean;
		/** The call triggered a user permission prompt (collector). */
		permission: boolean;
		title: string;
	}

	/** Step-segment slice: x/width are precomputed by the root. */
	interface NodeStepView {
		key: string;
		x: number;
		width: number;
		open: boolean;
		title: string;
	}

	/** Marker slice: compaction has an x; removed resolves to null. */
	interface NodeMarkerView {
		key: string;
		type: Marker['type'];
		x: number | null;
		title: string;
	}

	/**
	 * Minimal per-row view model rendered by a node row: a structural subset of
	 * the `Gantt` root's `RowView`. The root computes the full view model (row
	 * math, flags, tracker refs) and passes the SVG-relevant slice down.
	 */
	interface NodeRow {
		node: Node;
		top: number;
		barX: number;
		barWidth: number;
		/** Agent color for this row (md `color:` or the neutral fallback). */
		agentColor: string;
		running: boolean;
		/** Selection-only emphasis (never hover; see the root's `active:` note). */
		active: boolean;
		/** Dimmed while another row is hovered/selected. */
		dimmed: boolean;
		steps: NodeStepView[];
		tools: NodeToolView[];
		markers: NodeMarkerView[];
	}

	interface Props {
		row: NodeRow;
		/** x anchor for the non-positional removed marker (root-owned math). */
		removedAnchorX: number;
		/** Tube top offset inside the row (`BAR_TOP`). */
		barTop: number;
		/** Tube height (`BAR_H`). */
		barHeight: number;
		/** Tool-tick y offset inside the row (`TOOL_Y`). */
		toolY: number;
		/** Tool-tick height (`TOOL_H`). */
		toolHeight: number;
		/** Width of the removed-content hatch block (`REMOVED_W`). */
		removedWidth: number;
		onSelect: (nodeId: string) => void;
		onHover: (nodeId: string | null) => void;
		onRowKey: (event: KeyboardEvent, nodeId: string) => void;
	}

	let {
		row,
		removedAnchorX,
		barTop,
		barHeight,
		toolY,
		toolHeight,
		removedWidth,
		onSelect,
		onHover,
		onRowKey
	}: Props = $props();

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
</script>

<g
	class="node"
	class:active={row.active}
	style={`--agent:${row.agentColor}`}
	aria-pressed={row.active}
	opacity={row.dimmed ? 0.35 : 1}
	role="button"
	tabindex="0"
	aria-label={`${displayAgent(row.node.agent)} node ${nodeShortId(row.node.sessionId)}`}
	onclick={() => onSelect(row.node.sessionId)}
	onkeydown={(event) => onRowKey(event, row.node.sessionId)}
	onmouseenter={() => onHover(row.node.sessionId)}
	onmouseleave={() => onHover(null)}
>
	<!-- Node span tube (task #239/#253): tinted by the row's agent
	     color, thin. The x/y/width/height/rx="3" order and the
	     `fill="url(#running-hatch)"` presentation attribute are parsed by
	     the SSR tests and must stay. -->
	<rect
		x={row.barX}
		y={row.top + barTop}
		width={row.barWidth}
		height={barHeight}
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
			y={row.top + barTop + 2}
			width={step.width}
			height={barHeight - 4}
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
			y={row.top + toolY}
			width={tool.delegation ? 5 : 3}
			height={toolHeight}
			rx="1"
			style={`fill:${toolColor(tool.tone)}`}
		>
			<title>{tool.title}</title>
		</rect>
		{#if tool.permission}
			<circle class="tool-permission" cx={tool.x} cy={row.top + toolY - 3.5} r="2.6">
				<title>Permission requested for {tool.title}</title>
			</circle>
		{/if}
	{/each}

	<!-- Positional markers (compaction) -->
	{#each row.markers as marker (marker.key)}
		{#if marker.x !== null}
			<polygon
				class="marker"
				points={`${marker.x},${row.top + barTop - 2} ${marker.x + 5},${
					row.top + barTop + barHeight / 2
				} ${marker.x},${row.top + barTop + barHeight + 2} ${marker.x - 5},${
					row.top + barTop + barHeight / 2
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
			y={row.top + barTop}
			width={removedWidth}
			height={barHeight}
			rx="3"
			fill="url(#removed-hatch)"
			class="removed"
		>
			<title>{marker.title}</title>
		</rect>
	{/each}
</g>

<style>
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

	.marker {
		stroke: var(--background-base);
		stroke-width: 1;
	}

	.removed {
		stroke: var(--color-danger-base);
		stroke-width: 1;
	}

	.node {
		cursor: pointer;
	}

	.node:focus-visible {
		outline: 2px solid var(--border-selected);
		outline-offset: 2px;
	}
</style>
