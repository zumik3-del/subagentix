import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	assignModelColors,
	buildTicks,
	computeTimeScale,
	FALLBACK_CHART_W,
	MODEL_PALETTE,
	nodeShortId,
	orderNodes,
	toolTone,
	turnExtent
} from './gantt';
import type { GanttModel, Node, Step, ToolCall, Usage } from './types';

/**
 * Unit tests for the pure Gantt layout helpers (task #191 / M3b, task #190).
 *
 * No DB and no server imports: `gantt.ts` is imported by the client-side
 * Gantt component, so it must stay deterministic and DOM-free. These tests pin
 * the ordering, time-domain, tick, palette, tool-tone and label contracts.
 */

const usage = (): Usage => ({
	input: 0,
	output: 0,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	cost: 0
});

function makeNode(overrides: Partial<Node> & { sessionId: string; startedAt: number }): Node {
	return {
		parentSessionId: null,
		agent: 'build',
		kind: 'orchestrator',
		modelId: 'gpt-5',
		providerId: 'openai',
		depth: 0,
		directory: '/repo/a',
		status: 'completed',
		endedAt: overrides.startedAt + 100,
		running: false,
		flags: [],
		usage: usage(),
		stepCount: 0,
		toolCallCount: 0,
		errorCount: 0,
		compactionCount: 0,
		openStep: false,
		...overrides
	};
}

function makeStep(overrides: Partial<Step> & { id: string; startedAt: number }): Step {
	return {
		nodeId: 'n',
		messageId: 'm',
		index: 0,
		endedAt: overrides.startedAt + 100,
		open: false,
		flags: [],
		reason: 'stop',
		usage: usage(),
		modelId: 'gpt-5',
		hasCompaction: false,
		toolCallIds: [],
		...overrides
	};
}

function makeTool(overrides: Partial<ToolCall> & { id: string }): ToolCall {
	return {
		nodeId: 'n',
		stepId: null,
		callId: 'c',
		name: 'bash',
		status: 'completed',
		error: null,
		startedAt: 0,
		endedAt: 100,
		flags: [],
		input: null,
		output: null,
		isMcp: false,
		isDelegation: false,
		trackerRefs: [],
		...overrides
	};
}

function makeModel(overrides: Partial<GanttModel> = {}): GanttModel {
	return {
		turnId: 'r_u1',
		rootSessionId: 'r',
		agent: 'build',
		t0: 0,
		t1: 1_000,
		nodes: [],
		edges: [],
		steps: [],
		toolCalls: [],
		markers: [],
		...overrides
	};
}

describe('orderNodes()', () => {
	test('walks the delegation tree: each parent immediately before its children', () => {
		const root = makeNode({ sessionId: 'root', startedAt: 100 });
		const child1 = makeNode({ sessionId: 'child1', startedAt: 500, parentSessionId: 'root', depth: 1 });
		const grandchild = makeNode({
			sessionId: 'grandchild',
			startedAt: 600,
			parentSessionId: 'child1',
			depth: 2
		});
		const child2 = makeNode({ sessionId: 'child2', startedAt: 700, parentSessionId: 'root', depth: 1 });

		// Deliberately shuffled input.
		const ordered = orderNodes([child2, grandchild, root, child1]).map((node) => node.sessionId);
		expect(ordered).toEqual(['root', 'child1', 'grandchild', 'child2']);
	});

	test('siblings and roots are ordered by start time', () => {
		const late = makeNode({ sessionId: 'late', startedAt: 900 });
		const early = makeNode({ sessionId: 'early', startedAt: 100 });
		const mid1 = makeNode({ sessionId: 'mid1', startedAt: 400, parentSessionId: 'early', depth: 1 });
		const mid2 = makeNode({ sessionId: 'mid2', startedAt: 300, parentSessionId: 'early', depth: 1 });

		expect(orderNodes([late, mid2, early, mid1]).map((node) => node.sessionId)).toEqual([
			'early',
			'mid2',
			'mid1',
			'late'
		]);
	});

	test('equal start times use a deterministic sessionId tie-break (stable order)', () => {
		const b = makeNode({ sessionId: 'bbb', startedAt: 100 });
		const a = makeNode({ sessionId: 'aaa', startedAt: 100 });
		expect(orderNodes([b, a]).map((node) => node.sessionId)).toEqual(['aaa', 'bbb']);

		const cb = makeNode({ sessionId: 'z-child', startedAt: 100, parentSessionId: 'aaa', depth: 1 });
		const ca = makeNode({ sessionId: 'a-child', startedAt: 100, parentSessionId: 'aaa', depth: 1 });
		expect(orderNodes([cb, ca, a]).map((node) => node.sessionId)).toEqual(['aaa', 'a-child', 'z-child']);
	});

	test('a node flagged orphanEdge is still nested under a present parent', () => {
		const root = makeNode({ sessionId: 'root', startedAt: 100 });
		const child = makeNode({
			sessionId: 'child',
			startedAt: 200,
			parentSessionId: 'root',
			depth: 1,
			flags: ['orphanEdge']
		});
		expect(orderNodes([child, root]).map((node) => node.sessionId)).toEqual(['root', 'child']);
	});

	test('a node whose parent is absent from the set is treated as a root (orphan edge)', () => {
		const orphan = makeNode({
			sessionId: 'orphan',
			startedAt: 100,
			parentSessionId: 'ghost',
			flags: ['orphanEdge']
		});
		const realRoot = makeNode({ sessionId: 'root', startedAt: 200 });
		const child = makeNode({ sessionId: 'child', startedAt: 50, parentSessionId: 'ghost', depth: 1 });

		// Both orphan points at `ghost`; they must not be dropped.
		expect(orderNodes([orphan, realRoot, child]).map((node) => node.sessionId).sort()).toEqual([
			'child',
			'orphan',
			'root'
		]);
	});

	test('a self-parent node is treated as a root', () => {
		const self = makeNode({ sessionId: 'self', startedAt: 100, parentSessionId: 'self' });
		expect(orderNodes([self])).toEqual([self]);
	});

	test('a parent_id cycle terminates and returns every node exactly once', () => {
		const a = makeNode({ sessionId: 'A', startedAt: 100, parentSessionId: 'B' });
		const b = makeNode({ sessionId: 'B', startedAt: 200, parentSessionId: 'A' });
		const ordered = orderNodes([a, b]);
		expect(ordered).toHaveLength(2);
		expect(new Set(ordered.map((node) => node.sessionId))).toEqual(new Set(['A', 'B']));
	});

	test('returns an empty list for empty input', () => {
		expect(orderNodes([])).toEqual([]);
	});
});

describe('turnExtent()', () => {
	test('widens the turn window by every node, step and tool span', () => {
		const model = makeModel({
			t0: 1_000,
			t1: 6_000,
			nodes: [makeNode({ sessionId: 'n', startedAt: 1_200, endedAt: 5_000 })],
			steps: [makeStep({ id: 's', startedAt: 900, endedAt: 4_000 })],
			toolCalls: [makeTool({ id: 't', startedAt: 800, endedAt: 3_000 })]
		});
		expect(turnExtent(model)).toEqual({ start: 800, end: 6_000 });
	});

	test('includes a running node (endedAt=null) via its start and the turn t1', () => {
		const model = makeModel({
			t0: 1_000,
			t1: 1_000,
			nodes: [makeNode({ sessionId: 'running', startedAt: 500, endedAt: null, running: true })]
		});
		const extent = turnExtent(model);
		expect(extent.start).toBe(500);
		expect(extent.end).toBeGreaterThanOrEqual(500);
	});

	test('an open step and a running tool with no end do not break the domain', () => {
		const model = makeModel({
			t0: 1_000,
			t1: 2_000,
			nodes: [makeNode({ sessionId: 'n', startedAt: 1_000, endedAt: null, running: true })],
			steps: [makeStep({ id: 'open', startedAt: 1_500, endedAt: null, open: true })],
			toolCalls: [makeTool({ id: 'run', startedAt: 1_800, endedAt: null })]
		});
		const extent = turnExtent(model);
		expect(extent.start).toBe(1_000);
		expect(extent.end).toBe(2_000);
	});

	test('a tool with startedAt=null does not shift the window', () => {
		const model = makeModel({
			t0: 1_000,
			t1: 3_000,
			toolCalls: [makeTool({ id: 'no-start', startedAt: null, endedAt: 2_000 })]
		});
		expect(turnExtent(model)).toEqual({ start: 1_000, end: 3_000 });
	});

	test('never returns a zero-width span for a degenerate turn', () => {
		const model = makeModel({
			t0: 1_000,
			t1: 1_000,
			nodes: [makeNode({ sessionId: 'n', startedAt: 1_000, endedAt: 1_000 })]
		});
		const extent = turnExtent(model);
		expect(extent.end).toBeGreaterThan(extent.start);
		expect(extent).toEqual({ start: 1_000, end: 1_001 });
	});

	test('never returns an inverted span when an end precedes the start', () => {
		const model = makeModel({
			t0: 5_000,
			t1: 1_000,
			nodes: [makeNode({ sessionId: 'n', startedAt: 5_000, endedAt: 1_000 })]
		});
		const extent = turnExtent(model);
		expect(extent.end).toBeGreaterThan(extent.start);
		expect(extent).toEqual({ start: 5_000, end: 5_001 });
	});

	test('falls back to finite values when a timestamp is NaN', () => {
		const model = makeModel({
			t0: 1_000,
			t1: 2_000,
			nodes: [makeNode({ sessionId: 'n', startedAt: Number.NaN, endedAt: Number.NaN })]
		});
		const extent = turnExtent(model);
		expect(Number.isFinite(extent.start)).toBe(true);
		expect(Number.isFinite(extent.end)).toBe(true);
		expect(extent.end).toBeGreaterThan(extent.start);
	});
});

/**
 * Task #224: the width-fitted scale has no `MIN_PX_PER_MS` floor — every span
 * is compressed onto exactly the available width, so a long turn never
 * overflows into a horizontal scrollbar.
 */
describe('computeTimeScale()', () => {
	test('a short turn scales up so its data fills the available width', () => {
		const { pxPerMs, chartWidth } = computeTimeScale(15_000, 720);
		expect(pxPerMs).toBe(720 / 15_000);
		expect(chartWidth).toBe(720);
	});

	test('a long turn is compressed to fit the same width (no floor, no overflow)', () => {
		const { pxPerMs, chartWidth } = computeTimeScale(120_000, 720);
		expect(pxPerMs).toBe(720 / 120_000);
		expect(chartWidth).toBe(720);
	});

	test('an extreme span still fits exactly (chartWidth === safeWidth)', () => {
		const { pxPerMs, chartWidth } = computeTimeScale(10_000_000, 900);
		expect(pxPerMs).toBe(900 / 10_000_000);
		expect(chartWidth).toBe(900);
	});

	test('chartWidth equals the safe available width across short and very long spans', () => {
		for (const span of [1, 15_000, 36_000, 120_000, 500_000, 10_000_000]) {
			expect(computeTimeScale(span, 900).chartWidth).toBe(900);
		}
	});

	test('an unmeasured container (availableWidth <= 0) falls back to FALLBACK_CHART_W', () => {
		for (const width of [0, -1, -10_000, Number.NaN]) {
			const { chartWidth } = computeTimeScale(15_000, width);
			expect(chartWidth).toBe(FALLBACK_CHART_W);
		}
	});

	test('a long span under the SSR fallback fits exactly the fallback width', () => {
		const { pxPerMs, chartWidth } = computeTimeScale(120_000, 0);
		expect(pxPerMs).toBe(FALLBACK_CHART_W / 120_000);
		expect(chartWidth).toBe(FALLBACK_CHART_W);
	});

	test('a short turn under the SSR fallback fills exactly the fallback width', () => {
		const { pxPerMs, chartWidth } = computeTimeScale(15_000, 0);
		expect(pxPerMs).toBe(FALLBACK_CHART_W / 15_000);
		expect(chartWidth).toBe(FALLBACK_CHART_W);
	});

	test('degrades span 0 / negative / NaN to a finite 1 ms span without NaN geometry', () => {
		for (const span of [
			0,
			-1,
			-120_000,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY
		]) {
			const { pxPerMs, chartWidth } = computeTimeScale(span, 720);
			expect(Number.isFinite(pxPerMs)).toBe(true);
			expect(Number.isFinite(chartWidth)).toBe(true);
			expect(pxPerMs).toBeGreaterThan(0);
			expect(chartWidth).toBe(720);
		}
	});

	test('is deterministic for identical input', () => {
		expect(computeTimeScale(12_345, 800)).toEqual(computeTimeScale(12_345, 800));
	});
});

describe('Gantt.svelte — fitted chart relies on ScrollView, not horizontal overflow (#224)', () => {
	const gantt = readFileSync(new URL('../components/features/gantt/Gantt.svelte', import.meta.url), 'utf8');

	test('the chart is wrapped in a horizontal ScrollView that measures the viewport', () => {
		expect(gantt).toContain(
			'<ScrollView orientation="horizontal" bind:viewportWidth={scrollWidth}>'
		);
		expect(gantt).toContain(
			'const availableWidth = $derived(scrollWidth > 0 && labelWidth > 0 ? scrollWidth - labelWidth : 0);'
		);
		expect(gantt).toContain('const scale = $derived(computeTimeScale(span, availableWidth));');
	});

	test('the .scroll frame clamps instead of scrolling horizontally', () => {
		const rule = gantt.match(/\.scroll \{[^}]*\}/)?.[0] ?? '';
		expect(rule).not.toBe('');
		expect(rule).toContain('overflow: hidden');
		expect(rule).not.toContain('overflow-x: auto');
	});
});

describe('buildTicks()', () => {
	test('returns a single start tick for a zero or inverted span', () => {
		expect(buildTicks(1_000, 1_000, 10)).toEqual([1_000]);
		expect(buildTicks(1_000, 900, 10)).toEqual([1_000]);
	});

	test('is strictly monotonic and never leaves [start, end]', () => {
		const ticks = buildTicks(1_000, 10_000, 10);
		expect(ticks.length).toBeGreaterThan(1);
		expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
		expect(new Set(ticks).size).toBe(ticks.length);
		expect(ticks[0]).toBeGreaterThanOrEqual(1_000);
		expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(10_000);
	});

	test('covers t0..t1 within one step of each edge', () => {
		const start = 1_000;
		const end = 3_600_000 + 1_000;
		const ticks = buildTicks(start, end, 8);
		const step = ticks[1] - ticks[0];
		expect(ticks[0] - start).toBeLessThan(step);
		expect(end - ticks[ticks.length - 1]).toBeLessThan(step);
	});

	test('rounds the first tick up to a nice step boundary', () => {
		// 1_000 ms is itself a nice step, so with span 10_000 the first tick is 1_000.
		expect(buildTicks(1_000, 11_000, 10)[0]).toBe(1_000);
		// An unaligned start moves the first tick up, never below `start`.
		expect(buildTicks(1_234, 20_000, 10)[0]).toBeGreaterThanOrEqual(1_234);
	});

	test('honours the target count as a hint without exploding', () => {
		const coarse = buildTicks(0, 60_000, 2);
		const fine = buildTicks(0, 60_000, 60);
		expect(coarse.length).toBeLessThanOrEqual(fine.length);
		expect(fine.length).toBeLessThanOrEqual(5_000);
		// targetCount < 1 is clamped, not a division by zero.
		expect(buildTicks(0, 60_000, 0).length).toBeGreaterThan(0);
	});
});

/**
 * Task #215: the model palette must not reintroduce a blue/cyan hue (the UI
 * accent is neutral now). "Blue-dominant" is measured by HSL hue — the removed
 * `#06b6d4` sat at ~189° and `#4f8cff` at ~219°, so every entry must fall
 * outside the cyan/blue band. Greens (~80°–160°), purples (~270°) and pinks
 * (~330°) are in range; only the blue/cyan band is rejected.
 */
const BLUE_CYAN_HUE_MIN = 180;
const BLUE_CYAN_HUE_MAX = 255;

/**
 * Task #218: the palette went pastel and the old leading red (`#ef4444`, hue 0°)
 * is gone. Task #215 had already removed blue/cyan; this guards the other end of
 * the wheel so a warm red never becomes the first model color again.
 */
const RED_HUE_MAX = 15;
const RED_HUE_MIN = 345;

function hslHue(hex: string): number {
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;
	if (delta === 0) return 0;
	let sector: number;
	if (max === r) sector = ((g - b) / delta) % 6;
	else if (max === g) sector = (b - r) / delta + 2;
	else sector = (r - g) / delta + 4;
	return (((sector * 60) % 360) + 360) % 360;
}

describe('MODEL_PALETTE (task #215 — blue/cyan-free palette)', () => {
	test('every entry is a valid 6-digit lowercase hex color', () => {
		for (const color of MODEL_PALETTE) {
			expect(color, `invalid hex: ${color}`).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	test('entries are distinct', () => {
		expect(new Set(MODEL_PALETTE).size).toBe(MODEL_PALETTE.length);
	});

	test('no entry is blue-dominant (hue outside the cyan/blue band)', () => {
		for (const color of MODEL_PALETTE) {
			const hue = hslHue(color);
			const isBlueCyan = hue >= BLUE_CYAN_HUE_MIN && hue <= BLUE_CYAN_HUE_MAX;
			expect(isBlueCyan, `${color} has hue ${hue.toFixed(1)}°`).toBe(false);
		}
	});

	test('the removed blue/cyan accent hexes never come back', () => {
		for (const removed of ['#4f8cff', '#06b6d4']) {
			expect(MODEL_PALETTE, `${removed} is blue/cyan`).not.toContain(removed);
		}
	});

	test('the first palette entry is not red-dominant (red is not first)', () => {
		const first = MODEL_PALETTE[0];
		const hue = hslHue(first);
		const isRed = hue <= RED_HUE_MAX || hue >= RED_HUE_MIN;
		expect(isRed, `${first} has hue ${hue.toFixed(1)}°`).toBe(false);
	});
});

describe('assignModelColors()', () => {
	test('assigns palette colors in first-seen order and skips null/duplicates', () => {
		const colors = assignModelColors(['a', 'b', 'a', null, 'c']);
		expect([...colors.keys()]).toEqual(['a', 'b', 'c']);
		expect(colors.get('a')).toBe(MODEL_PALETTE[0]);
		expect(colors.get('b')).toBe(MODEL_PALETTE[1]);
		expect(colors.get('c')).toBe(MODEL_PALETTE[2]);
	});

	test('gives distinct models distinct colors', () => {
		const models = ['m0', 'm1', 'm2', 'm3', 'm4'];
		const colors = assignModelColors(models);
		expect(new Set(colors.values()).size).toBe(models.length);
	});

	test('is deterministic for the same input', () => {
		const input = ['a', 'b', null, 'c'];
		expect([...assignModelColors(input).entries()]).toEqual([...assignModelColors(input).entries()]);
	});

	test('wraps the palette when there are more models than colors', () => {
		const models = Array.from({ length: MODEL_PALETTE.length + 1 }, (_, i) => `m${i}`);
		const colors = assignModelColors(models);
		expect(colors.size).toBe(models.length);
		expect(colors.get(`m${MODEL_PALETTE.length}`)).toBe(MODEL_PALETTE[0]);
	});

	test('handles an all-null / empty input', () => {
		expect(assignModelColors([]).size).toBe(0);
		expect(assignModelColors([null, null]).size).toBe(0);
	});
});

describe('toolTone()', () => {
	test('maps the tool status vocabulary onto four render tones', () => {
		expect(toolTone('completed')).toBe('completed');
		expect(toolTone('complete')).toBe('completed');
		expect(toolTone('success')).toBe('completed');
		expect(toolTone('error')).toBe('error');
		expect(toolTone('failed')).toBe('error');
		expect(toolTone('running')).toBe('running');
		expect(toolTone('pending')).toBe('running');
		expect(toolTone('unknown')).toBe('other');
		expect(toolTone('')).toBe('other');
	});

	test('is case-insensitive', () => {
		expect(toolTone('COMPLETED')).toBe('completed');
		expect(toolTone('Error')).toBe('error');
		expect(toolTone('RUNNING')).toBe('running');
	});
});

describe('nodeShortId()', () => {
	test('leaves ids of 16 characters or fewer untouched', () => {
		expect(nodeShortId('short')).toBe('short');
		expect(nodeShortId('0123456789abcdef')).toBe('0123456789abcdef');
	});

	test('compacts longer ids to first 10 + ellipsis + last 4', () => {
		expect(nodeShortId('0123456789abcdefg')).toBe('0123456789…defg');
		expect(nodeShortId('ses_1234567890abcdef')).toBe('ses_123456…cdef');
	});
});

// --- Task #239 / #247: agent swatch, neutral tube, no Agents legend ----------

describe('Gantt #239/#247 — agent swatch, neutral tube, legend contract', () => {
	const gantt = readFileSync(new URL('../components/features/gantt/Gantt.svelte', import.meta.url), 'utf8');
	// Task #277: the legend markup and CSS moved to GanttLegend.svelte.
	const ganttLegend = readFileSync(new URL('../components/features/gantt/GanttLegend.svelte', import.meta.url), 'utf8');
	// Task #279: the label row (swatch/name/model/flags/chips) moved to GanttLabelRow.svelte.
	const ganttLabelRow = readFileSync(
		new URL('../components/features/gantt/GanttLabelRow.svelte', import.meta.url),
		'utf8'
	);
	// Task #280: the SVG shell and its <defs> patterns moved to GanttChart.svelte.
	const ganttChart = readFileSync(new URL('../components/features/gantt/GanttChart.svelte', import.meta.url), 'utf8');
	// Task #282: the SVG node group (tube/steps/tools/markers) moved to GanttNodeRow.svelte.
	const ganttNodeRow = readFileSync(
		new URL('../components/features/gantt/GanttNodeRow.svelte', import.meta.url),
		'utf8'
	);

	test('node swatch uses row.agentColor (agentColors fallback to AGENT_FALLBACK_COLOR)', () => {
		// The swatch style is driven by the RowView agentColor field, not a raw lookup.
		expect(ganttLabelRow).toContain("style={`background:${row.agentColor}`}");
	});

	test('no Agents legend group: title, iteration and derived are all absent', () => {
		// Task #247 dropped the Agents legend section entirely; task #277 moved
		// the remaining legend to GanttLegend, so assert against its source.
		expect(ganttLegend).not.toContain('<span class="legend-title">Agents</span>');
		expect(ganttLegend).not.toContain('{#each legendAgents as [agent, color] (agent)}');
		expect(ganttLegend).not.toContain('legendAgents');
	});

	test('legendAgents is not derived anywhere in the component', () => {
		// The derived must not appear as a variable or binding.
		expect(ganttLegend).not.toMatch(/legendAgents/);
	});

	test('the gray .model span renders row.node.modelId above the flags and is omitted when null', () => {
		// The model label sits inside the .label-btn, above the flags and before tracker refs.
		expect(ganttLabelRow).toContain('{#if row.node.modelId}');
		expect(ganttLabelRow).toContain('<span class="model">{row.node.modelId}</span>');
		// No Models legend section exists (task #253 dropped it alongside Agents;
		// task #277 moved the legend source to GanttLegend).
		expect(ganttLegend).not.toContain('<span class="legend-title">Models</span>');
		expect(ganttLegend).not.toMatch(/legendModels/);
	});

	test('the node group carries --agent so .bar and .step derive their tints from it', () => {
		// Each row <g> sets the custom property that the CSS rules consume.
		// Task #282: the node group moved to GanttNodeRow.
		expect(ganttNodeRow).toContain('style={`--agent:${row.agentColor}`}');
		// RowView.agentColor falls back to AGENT_FALLBACK_COLOR when agentColors has no entry.
		expect(gantt).toContain('AGENT_FALLBACK_COLOR');
	});

	test('the node tube is agent-tinted: fill/stroke via color-mix of var(--agent)', () => {
		// Task #253: the tube is no longer neutral — it tints by the row's agent color.
		// Task #282: the tube CSS moved to GanttNodeRow.
		const barRule = ganttNodeRow.match(/\.bar\s*\{[^}]*\}/)?.[0] ?? '';
		expect(barRule).toContain('fill: color-mix(in srgb, var(--agent) 30%, var(--background-strong))');
		expect(barRule).toContain('stroke: color-mix(in srgb, var(--agent) 65%, var(--background-strong))');
		expect(barRule).toContain('stroke-width: 0.75');
		// Neutral tokens are fine; model-driven palette vars (sage/ember/amber/lilac/icon/*-dark-*) are not.
		expect(barRule).not.toMatch(/var\(--(?:sage|ember|amber|lilac|icon|solaris)-/);
	});

	test('a running node keeps the url(#running-hatch) fill', () => {
		// The rect's fill presentation attribute switches to the running hatch pattern.
		// Task #282: the tube markup/CSS moved to GanttNodeRow.
		expect(ganttNodeRow).toContain("fill={row.running ? 'url(#running-hatch)' : undefined}");
		// The CSS class mirrors this so the pattern stays visible under the neutral base.
		expect(ganttNodeRow).toContain('class:bar-running={row.running}');
		const runningRule = ganttNodeRow.match(/\.bar\.bar-running\s*\{[^}]*\}/)?.[0] ?? '';
		expect(runningRule).toContain('fill: url(#running-hatch)');
	});

	test('step spans use agent-tone color-mix CSS, not an inline step.color fill', () => {
		// Task #253: steps no longer carry an inline fill from a model-color lookup.
		// Task #282: the step markup/CSS moved to GanttNodeRow.
		expect(ganttNodeRow).not.toContain('fill={step.color}');
		// The .step CSS rule sets the fill via --agent (stronger tube tint).
		const stepRule = ganttNodeRow.match(/\.step\s*\{[^}]*\}/)?.[0] ?? '';
		expect(stepRule).toContain('fill: color-mix(in srgb, var(--agent) 55%, var(--background-strong))');
		expect(stepRule).toContain('stroke: var(--background-base)');
		expect(stepRule).toContain('stroke-width: 1');
	});

	test('the running-hatch SVG pattern is defined in <defs>', () => {
		// Task #280: the pattern definitions moved to GanttChart.svelte.
		expect(ganttChart).toContain('id="running-hatch"');
		expect(ganttChart).toContain('patternTransform="rotate(45)"');
	});

	// --- Task #247: removed marker and legend styling --------------------------

	test('the chart removed marker rect has height={barHeight} and rx="3" with no removed-text/rem label', () => {
		// The removed rect is rendered without any text child — only a <title>.
		// Task #282: the marker rect moved to GanttNodeRow (height prop = BAR_H).
		expect(ganttNodeRow).toContain('height={barHeight}');
		expect(ganttNodeRow).toContain('rx="3"');
		expect(ganttNodeRow).not.toContain('removed-text');
		expect(ganttNodeRow).not.toMatch(/<text[^>]*>rem<\/text>/);
	});

	test('.removed-chip is 14×9 with border-radius 2px, critical hatch, no font-size/padding/color', () => {
		// Task #277: the markers legend (and this chip) moved to GanttLegend.
		const chipRule = ganttLegend.match(/\.removed-chip\s*\{[^}]*\}/)?.[0] ?? '';
		expect(chipRule).toContain('width: 14px');
		expect(chipRule).toContain('height: 9px');
		expect(chipRule).toContain('border-radius: 2px');
		expect(chipRule).toContain('var(--surface-critical-strong)');
		expect(chipRule).toContain('var(--color-danger-strong)');
		expect(chipRule).not.toMatch(/font-size:/);
		expect(chipRule).not.toMatch(/padding:/);
		expect(chipRule).not.toMatch(/color:/);
	});

	test('.legend is center-aligned; no .flags-legend / Flags present / presentFlags / ALL_FLAG_HELP; icon alignment via display:block + align-items/line-height', () => {
		// Task #277: the `.legend` styles moved to GanttLegend.svelte.
		const legendRule = ganttLegend.match(/\.legend\s*\{[^}]*\}/)?.[0] ?? '';
		const flagsRule = ganttLegend.match(/\.flags-legend\s*\{[^}]*\}/)?.[0] ?? '';
		expect(legendRule).toContain('justify-content: center');
		expect(flagsRule).toBe('');
		expect(ganttLegend).not.toContain('Flags present');
		expect(ganttLegend).not.toContain('presentFlags');
		expect(ganttLegend).not.toContain('ALL_FLAG_HELP');
		// Legend tick icons are block-aligned with parent flex row.
		expect(legendRule).toContain('align-items: center');
		expect(ganttLegend).toMatch(/\.legend \.tick[^{]*\{[^}]*display:\s*block/);
	});
});

// --- Task #241/#243/#255: smooth delegation connectors ------------------------

describe('Gantt #241/#243/#255 — delegation connector contract (source)', () => {
	// The `edgeLayout` derivation and `edgeTitle()` stay in the `Gantt` root.
	const gantt = readFileSync(new URL('../components/features/gantt/Gantt.svelte', import.meta.url), 'utf8');
	// Task #281: the edge <path> + diamond marker markup moved to GanttEdges.
	const ganttEdges = readFileSync(
		new URL('../components/features/gantt/GanttEdges.svelte', import.meta.url),
		'utf8'
	);
	// Task #282: the node tube markup/CSS moved to GanttNodeRow.
	const ganttNodeRow = readFileSync(
		new URL('../components/features/gantt/GanttNodeRow.svelte', import.meta.url),
		'utf8'
	);

	test('a single-child edge is a cubic Bézier from the spawn tick into the child tube cap', () => {
		// Edge layout: start at the spawn tick (edge.startedAt) on the parent row,
		// end at the child tube's left cap centre.
		expect(gantt).toContain(
			'const sx = edge.startedAt === null ? x(rows[childIndex].startedAt) : x(edge.startedAt);'
		);
		expect(gantt).toContain('const sy = parentTop + TOOL_Y + TOOL_H / 2;');
		expect(gantt).toContain('const ex = x(rows[childIndex].startedAt);');
		expect(gantt).toContain('const ey = childTop + BAR_TOP + BAR_H / 2;');
		// Rendered markup: a cubic <path> that swings right then arrives from the
		// left into the cap (the spawn tick and child start coincide on x, so the
		// fixed amplitude is what makes the S visible).
		expect(gantt).toContain('const dy = ey - sy;');
		expect(gantt).toContain('const a = Math.min(Math.max(dy * 0.3, 12), 34);');
		expect(gantt).toContain(
			'path: `M ${sx} ${sy} C ${sx + a} ${sy + dy * 0.33}, ${ex - a} ${ey}, ${ex} ${ey}`'
		);
		expect(ganttEdges).toContain('d={edge.path}');
		expect(ganttEdges).not.toContain('x1={edge.x}');
		expect(ganttEdges).not.toContain('points={edge.arrow}');
	});

	test('multi-spawn renders N parallel curves — no trunk, no branches', () => {
		// The edge layout loop pushes each edge as its own link; no bundling logic.
		expect(gantt).not.toContain('const trunkX = Math.min(');
		expect(gantt).not.toContain('class="edge-trunk"');
		expect(gantt).not.toContain('y1={bundle.topY}');
		expect(gantt).not.toContain('y2={bundle.bottomY}');
		expect(gantt).not.toContain('const baseX = childX >= trunkX');
		// Each edge renders the same cubic <path> pattern (in GanttEdges).
		expect(ganttEdges).toContain('<path');
		expect(ganttEdges).toContain('d={edge.path}');
	});

	test('a no-child edge keeps the diamond marker and is excluded from links', () => {
		// No-child edges push into `markers` and skip the link list.
		expect(gantt).toContain('markers.push({');
		// Diamond points: (mx, my-5) (mx+5, my) (mx, my+5) (mx-5, my) — the
		// marker markup moved to GanttEdges with the edge layer.
		expect(ganttEdges).toContain('edge.markerY - 5');
		expect(ganttEdges).toContain('edge.markerY + 5');
		expect(ganttEdges).toContain('edge.markerX + 5');
		expect(ganttEdges).toContain('edge.markerX - 5');
		// Marker Y centres on the parent row.
		expect(gantt).toContain('markerY: parentIndex === undefined ? null : parentTop + ROW_H / 2');
	});

	test('running edges keep the dash pattern; each edge keeps its <title>', () => {
		// Running dash on the drop line (rendered in GanttEdges).
		expect(ganttEdges).toContain("stroke-dasharray={edge.running ? '4 3' : undefined}");
		// Every edge link carries a <title>.
		expect(ganttEdges).toContain('<title>{edge.title}</title>');
	});

	test('the tube rect carries no class:bar-active binding (task #245)', () => {
		// Selection/focus no longer toggles a bar-active class on the node tube.
		// Task #282: the tube markup moved to GanttNodeRow.
		expect(ganttNodeRow).not.toContain('class:bar-active');
	});

	test('.bar CSS is invariant: no .bar.bar-active rule and no .node:focus-visible .bar stroke override (task #245)', () => {
		// The tube border uses the agent-tone stroke (task #253) and stays invariant.
		// Task #282: the tube/node CSS moved to GanttNodeRow.
		const barRule = ganttNodeRow.match(/\.bar\s*\{[^}]*\}/)?.[0] ?? '';
		expect(barRule).toContain('stroke: color-mix(in srgb, var(--agent) 65%, var(--background-strong))');
		expect(barRule).toContain('stroke-width: 0.75');
		// No recolor rule for .bar.bar-active.
		const activeRule = ganttNodeRow.match(/\.bar\.bar-active\s*\{[^}]*\}/)?.[0] ?? '';
		expect(activeRule).toBe('');
		// No stroke/stroke-width override on .bar under :focus-visible.
		const focusRule = ganttNodeRow.match(/\.node:focus-visible \.bar\s*\{[^}]*\}/)?.[0] ?? '';
		expect(focusRule).toBe('');
		// The :focus-visible rule that does exist only sets outline on the node.
		const nodeFocusRule = ganttNodeRow.match(/\.node:focus-visible\s*\{[^}]*\}/)?.[0] ?? '';
		expect(nodeFocusRule).toContain('outline: 2px solid var(--border-selected)');
	});

	test('delegation links are a thin gray stroke; dash and dim-opacity survive (task #255)', () => {
		// Each edge <path> uses the neutral gray token and a 1px width
		// (the path markup lives in GanttEdges).
		expect(ganttEdges).toContain('style="stroke:var(--icon-base)"');
		expect(ganttEdges).toContain('stroke-width="1"');
		// The edge <path> itself must not reference --border-selected.
		const edgePathMatch = ganttEdges.match(/<path[^>]*d=\{edge\.path\}[^>]*>/);
		expect(edgePathMatch).toBeTruthy();
		const edgePath = edgePathMatch![0];
		expect(edgePath).not.toContain('--border-selected');
		// Running dash and dimmed opacity are preserved.
		expect(ganttEdges).toContain("stroke-dasharray={edge.running ? '4 3' : undefined}");
		expect(ganttEdges).toContain('opacity={edge.dimmed ? 0.25 : 0.9}');
	});
});

// --- Task #251: node-column contract (session id removed, plain #N links) ------

describe('Gantt #251 — node-column regression', () => {
	const gantt = readFileSync(new URL('../components/features/gantt/Gantt.svelte', import.meta.url), 'utf8');
	// Task #278: the tracker-chip markup (and its `.ui-chip` classes) moved to
	// TrackerChipList.svelte.
	const trackerChipList = readFileSync(
		new URL('../components/composites/TrackerChipList.svelte', import.meta.url),
		'utf8'
	);
	// Task #279: the label column (`.labels`/`.axis-spacer`) moved to
	// GanttLabels.svelte and one row's label (`.label`/`.label-btn`/`.node-refs`)
	// to GanttLabelRow.svelte.
	const ganttLabels = readFileSync(new URL('../components/features/gantt/GanttLabels.svelte', import.meta.url), 'utf8');
	const ganttLabelRow = readFileSync(
		new URL('../components/features/gantt/GanttLabelRow.svelte', import.meta.url),
		'utf8'
	);
	// Task #282: the SVG node group (aria-label with the short id) moved to
	// GanttNodeRow.svelte.
	const ganttNodeRow = readFileSync(
		new URL('../components/features/gantt/GanttNodeRow.svelte', import.meta.url),
		'utf8'
	);

	test('no `.sid` CSS rule and no `<span class="sid">` in the component', () => {
		const sidRule = gantt.match(/\.sid\s*\{[^}]*\}/)?.[0] ?? '';
		expect(sidRule).toBe('');
		expect(gantt).not.toContain('class="sid"');
		expect(gantt).not.toContain("class='sid'");
	});

	test('.label is a flex row with align-items: stretch and fixed row height', () => {
		const labelRule = ganttLabelRow.match(/\.label\s*\{[^}]*\}/)?.[0] ?? '';
		expect(labelRule).toContain('display: flex');
		expect(labelRule).toContain('flex-direction: row');
		expect(labelRule).toContain('align-items: stretch');
		expect(labelRule).toContain('height: var(--row-h)');
		expect(labelRule).toContain('overflow: visible');
	});

	test('.label-btn flex-fills remaining row space; .node-refs is a sibling, not nested', () => {
		const btnRule = ganttLabelRow.match(/\.label-btn\s*\{[\s\S]*?\}/)?.[0] ?? '';
		expect(btnRule).toContain('flex: 1');
		expect(btnRule).toContain('min-width: 0');
		// `.node-refs` must appear after the closing `</button>`, not inside it.
		const btnCloseIdx = ganttLabelRow.indexOf('</button>');
		const nodeRefsIdx = ganttLabelRow.indexOf('node-refs');
		expect(btnCloseIdx).toBeGreaterThan(-1);
		expect(nodeRefsIdx).toBeGreaterThan(btnCloseIdx);
		// The label column keeps the sticky `.labels`/`.axis-spacer` in GanttLabels.
		expect(ganttLabels).toContain('class="labels"');
		expect(ganttLabels).toContain('class="axis-spacer"');
	});

	test('tracker chips use the shared .ui-chip primitive (pill, defined in app.css)', () => {
		expect(trackerChipList).toContain('class="ui-chip ui-chip--link"');
		expect(trackerChipList).toContain('class="ui-chip ui-chip--toggle"');
		// The old local `.chip` rule is gone from both surfaces.
		expect(trackerChipList).not.toMatch(/\.chip\s*\{/);
		expect(gantt).not.toMatch(/\.chip\s*\{/);
		const css = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');
		expect(css).toMatch(/\.ui-chip\s*\{[^}]*border-radius:\s*var\(--radius-full\)/);
	});

	test('.ui-link-btn:hover has underline and color highlight (app.css)', () => {
		const css = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');
		const hoverRule = css.match(/\.ui-link-btn:hover\s*\{[^}]*\}/)?.[0] ?? '';
		expect(hoverRule).toContain('text-decoration: underline');
		expect(hoverRule).toContain('color: var(--text-strong)');
	});

	test('.ui-chip--toggle remains a <button> in source', () => {
		expect(trackerChipList).toContain('class="ui-chip ui-chip--toggle"');
		expect(trackerChipList).toContain('<button');
		// The toggle class must be on a <button>, not an <a>.
		const toggleIdx = trackerChipList.indexOf('ui-chip--toggle');
		// Look backwards from the class to find the opening tag.
		const preceding = trackerChipList.slice(Math.max(0, toggleIdx - 200), toggleIdx);
		expect(preceding).toMatch(/<button/);
		expect(preceding).not.toMatch(/<a[^>]*ui-chip--toggle/);
	});

	test('nodeShortId survives in the SVG row aria-label', () => {
		// The header no longer reports the selection; only the SVG aria-label keeps it.
		expect(gantt).not.toContain('{nodeShortId(selectedNodeId)}');
		// Task #282: the SVG node group moved to GanttNodeRow.
		expect(ganttNodeRow).toContain('aria-label={`${displayAgent(row.node.agent)} node ${nodeShortId(row.node.sessionId)}`}');
	});
});
