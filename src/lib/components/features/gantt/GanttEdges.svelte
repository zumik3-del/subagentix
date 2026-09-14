<script module lang="ts">
	/**
	 * Edge view models rendered by `GanttEdges`: the root's `edgeLayout` slices.
	 * Declared here so the `Gantt` root can import the exact shapes it
	 * computes (`edgeLayout` / `edgeTitle()` stay in the root).
	 */
	export interface ConnectorView {
		id: string;
		/** SVG path `d`: cubic Bézier from the spawn tick to the child cap. */
		path: string;
		running: boolean;
		dimmed: boolean;
		title: string;
	}

	export interface MarkerEdgeView {
		id: string;
		color: string;
		active: boolean;
		dimmed: boolean;
		title: string;
		markerX: number | null;
		markerY: number | null;
	}
</script>

<script lang="ts">
	/**
	 * Delegation-edge layer of the wall-clock Gantt (extracted from `Gantt`,
	 * ADR 3.5b).
	 *
	 * Renders one gray cubic Bézier per edge from the parent's spawn tick into
	 * the child tube's left cap, plus the no-child diamond markers. Pure
	 * presentation: the `Gantt` root keeps the `edgeLayout` derivation and
	 * `edgeTitle()`, and passes the precomputed link/marker slices down, so
	 * this component owns no data logic.
	 */
	interface Props {
		/** Resolvable edges: one cubic connector per link. */
		links: ConnectorView[];
		/** No-child edges: diamond markers at the parent row centre. */
		markers: MarkerEdgeView[];
	}

	let { links, markers }: Props = $props();
</script>

<!-- Delegation edges (task #241/#243, S-curved #255): one gray cubic Bézier per
     edge from the parent's spawn tick into the child tube's left cap, plus
     no-child diamond markers. -->
{#each links as edge (edge.id)}
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

{#each markers as edge (edge.id)}
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
