<script lang="ts">
	/**
	 * uPlot time-series chart (dashboard Phase 4, task #411).
	 *
	 * Presentational, client-only renderer for one dense UTC-day series. uPlot
	 * (and its stylesheet) is dynamically imported inside `onMount`, so neither
	 * reaches the SSR module graph (spec §2.6/D1): `uplot` appears in this
	 * component exactly once, on the onMount dynamic-import path. The instance is
	 * destroyed and the `ResizeObserver` disconnected in the `onMount` cleanup,
	 * and the observer keeps the canvas at the container size.
	 *
	 * The canvas is decorative (`aria-hidden`); the same series is always exposed
	 * to assistive tech as a day/value table. If the chart chunk fails to load the
	 * table becomes the visible fallback instead of a blank box (spec R10).
	 */
	import { onMount } from 'svelte';
	import { utcDayKey, type DayBucket } from '$lib/model/chart';
	import { formatNumber } from '$lib/model/format';

	interface Props {
		/** Dense UTC-day buckets (`{ day: 'YYYY-MM-DD', value }`), ascending. */
		points: readonly DayBucket[];
		/** Series name; used as the a11y table caption/column header. */
		label: string;
		/** Formats a value for the axis and the a11y table; defaults to `formatNumber`. */
		formatValue?: (value: number) => string;
		/** `--chart-*` token for the series stroke; defaults to `--chart-1`. */
		colorVar?: string;
	}

	let { points, label, formatValue = formatNumber, colorVar = '--chart-1' }: Props = $props();

	/**
	 * Minimal uPlot surface actually driven. Declared locally so the library is
	 * referenced only through the onMount dynamic import (no static/type import
	 * that could pull it toward the SSR graph).
	 */
	interface UPlotInstance {
		setData(data: [number[], number[]]): void;
		setSize(size: { width: number; height: number }): void;
		destroy(): void;
	}
	interface UPlotConstructor {
		new (
			target: HTMLElement,
			options: Record<string, unknown>,
			data: [number[], number[]]
		): UPlotInstance;
	}

	/** Fallback canvas height until the container reports its own (CSS) height. */
	const DEFAULT_HEIGHT = 180;

	let host: HTMLDivElement | undefined = $state();
	let failed = $state(false);
	/** Live instance while mounted; plain (non-reactive) so it never loops an effect. */
	let chart: UPlotInstance | null = null;
	let disposed = false;
	let width = 0;
	let height = 0;

	/** Aligned uPlot data: x = UTC-midnight epoch-ms, y = value. */
	function toSeries(rows: readonly DayBucket[]): [number[], number[]] {
		const xs: number[] = [];
		const ys: number[] = [];
		for (const row of rows) {
			const at = Date.parse(`${row.day}T00:00:00.000Z`);
			if (!Number.isFinite(at)) continue;
			xs.push(at);
			ys.push(Number.isFinite(row.value) ? row.value : 0);
		}
		return [xs, ys];
	}

	/** Resolved value of a design token on the chart element, or `fallback`. */
	function readToken(name: string, fallback: string): string {
		if (!host) return fallback;
		const value = getComputedStyle(host).getPropertyValue(name).trim();
		return value.length > 0 ? value : fallback;
	}

	/** `#rrggbb` + alpha byte for the area fill; `null` for a non-hex token. */
	function withAlpha(color: string, alpha: string): string | null {
		return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : null;
	}

	function buildOptions(initialWidth: number, initialHeight: number): Record<string, unknown> {
		const stroke = readToken(colorVar, 'grey');
		const axis = readToken('--text-weak', 'grey');
		const grid = readToken('--border-weak-base', 'transparent');
		const fill = withAlpha(stroke, '24');
		const format = (value: number) => formatValue(value);
		return {
			width: initialWidth,
			height: initialHeight,
			// Day buckets are 86400000 ms apart; tells uPlot to snap x ticks to days.
			ms: 86_400_000,
			padding: [8, 8, 0, 0],
			legend: { show: false },
			cursor: { y: false },
			series: [
				{},
				{
					label,
					stroke,
					...(fill ? { fill } : {}),
					width: 2,
					points: { show: false },
					value: (_u: unknown, v: number | null) => (v == null ? '—' : format(v))
				}
			],
			axes: [
				{
					stroke: axis,
					grid: { stroke: grid, width: 1 },
					ticks: { stroke: grid },
					values: (_u: unknown, splits: number[]) => splits.map((v) => utcDayKey(v).slice(5))
				},
				{
					stroke: axis,
					grid: { stroke: grid, width: 1 },
					ticks: { stroke: grid },
					size: 56,
					values: (_u: unknown, splits: number[]) => splits.map((v) => format(v))
				}
			]
		};
	}

	/** Measured container size, or `null` while it has no laid-out width. */
	function measure(): { width: number; height: number } | null {
		if (!host) return null;
		const measuredWidth = Math.round(host.clientWidth);
		if (measuredWidth <= 0) return null;
		const measuredHeight = Math.round(host.clientHeight);
		return {
			width: measuredWidth,
			height: measuredHeight > 0 ? measuredHeight : DEFAULT_HEIGHT
		};
	}

	/** Resize the canvas when the container changes size. */
	function resize(): void {
		if (!chart) return;
		const size = measure();
		if (!size || (size.width === width && size.height === height)) return;
		width = size.width;
		height = size.height;
		chart.setSize(size);
	}

	onMount(() => {
		let observer: ResizeObserver | null = null;
		void (async () => {
			try {
				// Stylesheet + library load lazily with the widget; both live inside
				// the onMount path so neither is in the SSR graph.
				const [module] = await Promise.all([
					import('uplot'),
					import('uplot/dist/uPlot.min.css')
				]);
				if (disposed || !host) return;
				const UPlot = (module as unknown as { default: UPlotConstructor }).default;
				const size = measure() ?? { width: 320, height: DEFAULT_HEIGHT };
				width = size.width;
				height = size.height;
				chart = new UPlot(host, buildOptions(width, height), toSeries(points));
				if (typeof ResizeObserver !== 'undefined') {
					observer = new ResizeObserver(resize);
					observer.observe(host);
				}
			} catch {
				// Chunk load failed: fall back to the visible data table below.
				if (!disposed) failed = true;
			}
		})();

		return () => {
			disposed = true;
			observer?.disconnect();
			chart?.destroy();
			chart = null;
		};
	});

	// Same-scope refresh keeps the card `ready`, so update the existing instance
	// in place rather than remounting; a period/scope change resets the payload,
	// which unmounts this component through `WidgetCard` anyway.
	$effect(() => {
		const current = points;
		if (chart) chart.setData(toSeries(current));
	});
</script>

<figure class="ts-chart">
	{#if failed}
		<p class="ts-chart__note">Chart unavailable — showing the series as a table.</p>
	{:else}
		<div class="ts-chart__canvas" bind:this={host} aria-hidden="true"></div>
	{/if}
	<table class={failed ? 'ts-chart__table' : 'sr-only'}>
		<caption>{label} per day</caption>
		<thead>
			<tr>
				<th scope="col">Day</th>
				<th scope="col">{label}</th>
			</tr>
		</thead>
		<tbody>
			{#each points as point (point.day)}
				<tr>
					<th scope="row">{point.day}</th>
					<td>{formatValue(point.value)}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</figure>

<style>
	.ts-chart {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
		margin: 0;
		min-width: 0;
	}

	.ts-chart__canvas {
		flex: 1;
		width: 100%;
		min-width: 0;
		min-height: 0;
	}

	.ts-chart__note {
		margin: 0;
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.ts-chart__table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--font-size-small);
		color: var(--text-base);
	}

	.ts-chart__table th,
	.ts-chart__table td {
		padding: var(--space-1) var(--space-2);
		border-bottom: 1px solid var(--border-weak-base);
		text-align: left;
		font-weight: var(--font-weight-regular);
		font-variant-numeric: tabular-nums;
	}
</style>
