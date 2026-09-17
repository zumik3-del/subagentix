<script lang="ts">
	/**
	 * Top-projects widget body (dashboard Phase 4, task #412; pure renderer from
	 * the widget engine, task #491).
	 *
	 * Content-only: `WidgetShell` owns the fetch and the card chrome, so this
	 * component maps the ready Tier-S payload to horizontal bars. A ready payload
	 * is drawn by the hand-rolled `BarChart` (no chart library); a directory
	 * linked to a project shows the project name, else the last path segment,
	 * with the full path kept as the row title.
	 *
	 * It stays a separate body from `agent-distribution` (task #491): that widget
	 * renders a numeric table (swatch/name/count/share), this one renders
	 * inline-SVG bars — no common markup to share, and a merged "ranked-table"
	 * body would need a per-cell view-kind switch the engine avoids.
	 */
	import type { WidgetDataMap } from '$lib/model/dashboard';
	import type { WidgetRenderProps } from './widget';
	import BarChart from './BarChart.svelte';

	let { data }: WidgetRenderProps<'top-projects'> = $props();

	/** Short display label: the project name when linked, else the path's basename. */
	function projectLabel(entry: WidgetDataMap['top-projects'][number]): string {
		const name = entry.projectName?.trim();
		if (name) return name;
		const segments = entry.directory.split('/').filter((segment) => segment !== '');
		return segments.at(-1) ?? entry.directory;
	}

	/** Bar input: ranked rows keyed by directory, with the full path as the tooltip. */
	let bars = $derived(
		data.map((entry) => ({
			label: projectLabel(entry),
			value: entry.count,
			title: entry.directory
		}))
	);
</script>

<BarChart {bars} label="Top projects" colorVar="--chart-1" />
