/**
 * ScrollView overlay-scrollbar suite (task #225).
 *
 * Same constraints as the other component suites: there is no DOM runtime in
 * this repo (no jsdom / happy-dom / Playwright, dependency budget = SvelteKit
 * only) and no new dependencies, so the wrapper/viewport markup is exercised
 * through `vite.ssrLoadModule` -> `svelte/server` `render()`, while the
 * client-only behaviour (thumb visibility on hover/scroll/drag, the 800ms
 * auto-hide and the drag mapping) is pinned at the source level — the
 * established convention in `m3c-drilldown.suite.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };
type RawSnippetFactory = (setup: () => { render: () => string }) => unknown;

let vite: ViteDevServer;
let render: RenderFn;
let createRawSnippet: RawSnippetFactory;
let ScrollView: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;
	createRawSnippet = (
		(await vite.ssrLoadModule('svelte')) as { createRawSnippet: RawSnippetFactory }
	).createRawSnippet;
	ScrollView = (
		(await vite.ssrLoadModule('/src/lib/components/ScrollView.svelte')) as {
			default: unknown;
		}
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

function renderView(props: Record<string, unknown> = {}, content = '<span class="probe">content</span>'): string {
	const children = createRawSnippet(() => ({ render: () => content }));
	return render(ScrollView, { props: { children, ...props } }).body;
}

function source(relative: string): string {
	return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

function walkSvelte(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkSvelte(full));
		else if (entry.name.endsWith('.svelte')) out.push(full);
	}
	return out;
}

// --- Rendered structure (SSR) -----------------------------------------------

describe('ScrollView SSR — wrapper/viewport structure', () => {
	test('renders the group wrapper, the scrollable viewport and its children', () => {
		const html = renderView();
		expect(html).toContain('class="scroll-view ');
		expect(html).toContain('role="group"');
		expect(html).toContain('scroll-view__viewport');
		expect(html).toContain('scroll-view__viewport--vertical');
		expect(html).toContain('class="probe"');
	});

	test('the orientation prop selects the viewport axis class', () => {
		expect(renderView({ orientation: 'horizontal' })).toContain(
			'scroll-view__viewport--horizontal'
		);
		expect(renderView({ orientation: 'both' })).toContain('scroll-view__viewport--both');
	});

	test('extra classes are appended to the wrapper', () => {
		expect(renderView({ class: 'my-region' })).toContain('my-region');
	});

	test('no thumb renders before the client measures (thumbs are client-only)', () => {
		expect(renderView()).not.toContain('scroll-view__thumb');
	});
});

// --- CSS contract -----------------------------------------------------------

describe('ScrollView CSS — native bar hidden, neutral overlay thumb', () => {
	const svelte = source('./ScrollView.svelte');
	const style = svelte.slice(svelte.indexOf('<style>'));

	test('hides the native scrollbar on the viewport', () => {
		expect(style).toContain('scrollbar-width: none');
		expect(style).toMatch(/::-webkit-scrollbar \{\s*display: none;/);
	});

	test('the viewport scrolls per orientation', () => {
		expect(style).toMatch(/\.scroll-view__viewport--vertical \{[\s\S]*?overflow-y: auto/);
		expect(style).toMatch(/\.scroll-view__viewport--horizontal \{[\s\S]*?overflow-x: auto/);
		expect(style).toMatch(/\.scroll-view__viewport--both \{[\s\S]*?overflow: auto/);
	});

	test('thumb geometry, radius, blur, opacity and transition', () => {
		expect(style).toContain('width: 12px');
		expect(style).toContain('height: 12px');
		expect(style).toContain('border-radius: 9999px');
		expect(style).toContain('backdrop-filter: blur(4px)');
		expect(style).toContain('opacity: 0');
		expect(style).toContain('transition: opacity 0.2s');
		expect(style).toMatch(/\[data-visible='true'\] \{\s*opacity: 1;/);
	});

	test('only the neutral border tokens color the thumb (no hardcoded/blue value)', () => {
		expect(style).toContain('background-color: var(--border-weak-base)');
		expect(style).toContain('background-color: var(--border-strong-base)');
		// Tokens only: no hex color and no blue/cyan palette variable in the styles.
		expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(style).not.toContain('--blue');
		expect(style).not.toContain('--chart-');
	});
});

// --- Client behaviour (source contract; no DOM runtime) ---------------------

describe('ScrollView behaviour — visibility, auto-hide and drag (source contract)', () => {
	const svelte = source('./ScrollView.svelte');

	test('vertical and horizontal are derived from the orientation prop', () => {
		expect(svelte).toContain(
			"const vertical = $derived(orientation === 'vertical' || orientation === 'both');"
		);
		expect(svelte).toContain(
			"const horizontal = $derived(orientation === 'horizontal' || orientation === 'both');"
		);
	});

	test('thumb is visible on hover, scroll, drag or always', () => {
		expect(svelte).toMatch(
			/thumbVisibility === 'always' \|\|\s*isDragging \|\|\s*isScrolling \|\|\s*\(thumbVisibility === 'hover' && isHovered\)/
		);
		expect(svelte).toContain('onpointerenter={() => (isHovered = true)}');
		expect(svelte).toContain('onpointerleave={() => (isHovered = false)}');
	});

	test('scrolling shows the thumb and auto-hides it after 800ms', () => {
		expect(svelte).toContain('const SCROLL_HIDE_MS = 800;');
		expect(svelte).toMatch(
			/isScrolling = true;[\s\S]*?scrollTimer = setTimeout\(\(\) => \{\s*isScrolling = false;\s*\}, SCROLL_HIDE_MS\)/
		);
		expect(svelte).toContain('onscroll={onScroll}');
		expect(svelte).toContain('onwheel={markScrolling}');
	});

	test('both thumbs render with ARIA slider semantics and visibility state', () => {
		expect(svelte).toContain('role="slider"');
		expect(svelte).toContain('aria-label="Vertical scrollbar"');
		expect(svelte).toContain('aria-label="Horizontal scrollbar"');
		expect(svelte).toContain('data-visible={thumbVisible}');
		expect(svelte).toContain("data-dragging={isDragging && dragAxis === 'vertical'}");
		expect(svelte).toContain("data-dragging={isDragging && dragAxis === 'horizontal'}");
	});

	test('drag uses pointer capture and maps the pointer to scroll proportionally', () => {
		expect(svelte).toContain('target.setPointerCapture(event.pointerId)');
		expect(svelte).toContain('target.releasePointerCapture(endEvent.pointerId)');
		expect(svelte).toContain("target.addEventListener('pointermove', move)");
		expect(svelte).toContain("target.addEventListener('pointerup', end)");
		expect(svelte).toContain("target.addEventListener('pointercancel', end)");
		// Vertical maps to scrollTop, horizontal to scrollLeft.
		expect(svelte).toMatch(
			/el\.scrollTop = \(position \/ travel\) \* Math\.max\(0, el\.scrollHeight - el\.clientHeight\)/
		);
		expect(svelte).toMatch(
			/el\.scrollLeft = \(position \/ travel\) \* Math\.max\(0, el\.scrollWidth - el\.clientWidth\)/
		);
	});

	test('recomputes on resize/content changes and exposes the measured viewport', () => {
		expect(svelte).toContain('new ResizeObserver(scheduleMeasure)');
		expect(svelte).toContain('new MutationObserver(scheduleMeasure)');
		expect(svelte).toContain('requestAnimationFrame');
		expect(svelte).toContain('viewportWidth = el.clientWidth;');
		expect(svelte).toContain('viewportHeight = el.clientHeight;');
		expect(svelte).toContain('MIN_THUMB = 32');
	});
});

// --- Adoption: every scroll region is wrapped -------------------------------

describe('ScrollView adoption — every native scroll region is wrapped (task #225)', () => {
	const layout = source('../../routes/+layout.svelte');
	const gantt = source('./Gantt.svelte');
	const panel = source('./NodeDetailPanel.svelte');

	// #228: the outer ScrollView is removed from +layout; only the content column
	// is wrapped. The sidebar's own ScrollView lives inside SessionSidebar.
	test('+layout wraps only the content column (sidebar ScrollView moved into SessionSidebar, task #228)', () => {
		expect(layout).toContain("import ScrollView from '$lib/components/ScrollView.svelte';");
		const sidebarSlot = layout.slice(
			layout.indexOf('class="sidebar-slot"'),
			layout.indexOf('class="content"')
		);
		expect(sidebarSlot).not.toContain('<ScrollView>');
		expect(sidebarSlot).toContain('<SessionSidebar');
		const content = layout.slice(layout.indexOf('class="content"'));
		expect(content).toContain('<ScrollView>');
		expect(content).toContain('{@render children()}');
	});

	test('Gantt wraps the chart in a horizontal ScrollView that measures the viewport', () => {
		expect(gantt).toContain(
			'<ScrollView orientation="horizontal" bind:viewportWidth={scrollWidth}>'
		);
		expect(gantt).toMatch(
			/<ScrollView orientation="horizontal" bind:viewportWidth=\{scrollWidth\}>[\s\S]*?<div class="inner">/
		);
		const scrollRule = gantt.match(/\.scroll \{[^}]*\}/)?.[0] ?? '';
		expect(scrollRule).toContain('overflow: hidden');
		expect(scrollRule).not.toContain('overflow-x: auto');
	});

	test('NodeDetailPanel wraps the steps table, both io texts and the raw JSON', () => {
		expect(panel).toContain('class="table-scroll"');
		const tableScroll = panel.slice(panel.indexOf('class="table-scroll"'));
		expect(tableScroll.indexOf('<ScrollView orientation="horizontal">')).toBeLessThan(
			tableScroll.indexOf('<table>')
		);
		// Both input and output values use the default (vertical) ScrollView.
		expect(panel.split('<ScrollView>{').length - 1).toBe(3);
		expect(panel).toMatch(
			/<div class="raw">\s*<ScrollView>\{JSON\.stringify\(detail, null, 2\)\}<\/ScrollView>/
		);
	});

	test('no component keeps a native auto/scroll overflow outside ScrollView', () => {
		const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
		const offenders: string[] = [];
		for (const file of walkSvelte(join(repoRoot, 'src'))) {
			if (file.endsWith('ScrollView.svelte')) continue;
			const text = readFileSync(file, 'utf8');
			for (const match of text.matchAll(/overflow(?:-[xy])?:\s*(?:auto|scroll)/g)) {
				offenders.push(`${file.slice(repoRoot.length)}:${match[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

// --- Task #228: Sidebar header fixed, inner ScrollView, inset-active cue ------

describe('SessionSidebar structure — header outside inner ScrollView (task #228)', () => {
	const sidebar = source('./SessionSidebar.svelte');

	test('header is flex:none and sits above a single inner ScrollView', () => {
		// The .sidebar-header must be flex:none so it never scrolls.
		expect(sidebar).toContain('.sidebar-header {');
		expect(sidebar).toContain('flex: none');
		// The body tree lives inside one ScrollView; the header is outside it.
		const headerIdx = sidebar.indexOf('class="sidebar-header"');
		const scrollIdx = sidebar.indexOf('<ScrollView>');
		const bodyIdx = sidebar.indexOf('class="sidebar-body"');
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		expect(scrollIdx).toBeGreaterThanOrEqual(0);
		expect(bodyIdx).toBeGreaterThanOrEqual(0);
		// Header markup precedes the single ScrollView; sidebar-body is its child.
		expect(headerIdx).toBeLessThan(scrollIdx);
		expect(scrollIdx).toBeLessThan(bodyIdx);
		// Exactly one ScrollView in the component (the inner one wrapping tree/results).
		expect(sidebar.split('<ScrollView>').length - 1).toBe(1);
	});

	test('the active-turn parent session gets a title cue, not a left inset accent (task #239)', () => {
		// `.row.contains-active` class binding remains on the session button.
		expect(sidebar).toContain('class:contains-active={isActiveLeafParent}');
		// The session-title within an active-leaf-parent gets strong color + medium weight.
		expect(sidebar).toContain('.row.contains-active .session-title {');
		expect(sidebar).toContain('color: var(--text-strong)');
		expect(sidebar).toContain('font-weight: var(--font-weight-medium)');
		// The old left inset box-shadow accent was removed (task #239 AC).
		expect(sidebar).not.toContain('.row.contains-active {');
		// The pressed background must NOT appear on contains-active (no stacked selection).
		const activeBlock = sidebar.slice(
			sidebar.indexOf('.row.contains-active .session-title {'),
			sidebar.indexOf('.row:focus-visible {')
		);
		expect(activeBlock).not.toContain('--overlay-pressed');
	});

	test('the parent session is NOT styled selected when a turn inside it is active', () => {
		// `contains-active` is a separate class from `selected`; the CSS must not
		// conflate them (no `.row.contains-active` rule that also sets --overlay-pressed).
		const activeBlock = sidebar.slice(
			sidebar.indexOf('.row.contains-active {'),
			sidebar.indexOf('.row:focus-visible {')
		);
		expect(activeBlock).not.toContain('--overlay-pressed');
	});
});

// --- Task #229: Gantt labels/.chart shared background + full-row hit -----------

describe('Gantt layout — labels/chart share --background-strong, full-row label hit (task #229)', () => {
	const gantt = source('./Gantt.svelte');

	test('.labels and .chart both use --background-strong for a seamless row band', () => {
		const labelsRule = gantt.match(/\.labels \{[^}]*\}/)?.[0] ?? '';
		const chartRule = gantt.match(/\.chart \{[^}]*\}/)?.[0] ?? '';
		expect(labelsRule).toContain('background: var(--background-strong)');
		expect(chartRule).toContain('background: var(--background-strong)');
	});

	test('no zebra stripe remains: class:stripe, .label.stripe and SVG .stripe are all gone', () => {
		// Issue #8: uniform canvas, no alternating row backgrounds.
		expect(gantt).not.toContain('class:stripe={row.index % 2 === 1}');
		const stripeRule = gantt.match(/\.label\.stripe \{[^}]*\}/)?.[0] ?? '';
		expect(stripeRule).toBe('');
		expect(gantt).not.toMatch(/<rect[^>]*class="stripe"/);
		expect(gantt).not.toMatch(/\.stripe\s*\{/);
	});

	test('Gantt block shares one --background-strong canvas across .scroll/.labels/.chart', () => {
		const scrollRule = gantt.match(/\.scroll\s*\{[^}]*\}/)?.[0] ?? '';
		const labelsRule = gantt.match(/\.labels\s*\{[^}]*\}/)?.[0] ?? '';
		const chartRule = gantt.match(/\.chart\s*\{[^}]*\}/)?.[0] ?? '';
		expect(scrollRule).toContain('background: var(--background-strong)');
		expect(labelsRule).toContain('background: var(--background-strong)');
		expect(chartRule).toContain('background: var(--background-strong)');
	});

	test('the label button flex-fills the row for a full-row hit area', () => {
		const btnRule = gantt.match(/\.label-btn \{[\s\S]*?\}/)?.[0] ?? '';
		expect(btnRule).toContain('width: 100%');
		expect(btnRule).toContain('flex: 1');
	});

	test('the SVG maps clientY to row index via rowIndexAtY using AXIS_H / ROW_H', () => {
		expect(gantt).toContain('function rowIndexAtY(y: number): number | null');
		expect(gantt).toContain('Math.floor((y - AXIS_H) / ROW_H)');
		expect(gantt).toContain('if (y < AXIS_H) return null');
		// Both the hover handler and the click handler call rowIndexAtY.
		expect(gantt).toContain('const index = rowIndexAtY(event.clientY - rect.top)');
	});
});

// --- Task #234: uniform canvas + inset axis header band (#8 / #9) --------------

describe('Gantt #234 — uniform canvas, inset band, axis header (issues #8 / #9)', () => {
	const gantt = source('./Gantt.svelte');

	test('INSET and TICK_EDGE constants are declared', () => {
		expect(gantt).toContain('const INSET = 16;');
		expect(gantt).toContain('const TICK_EDGE = 26;');
	});

	test('SVG row hairline uses --border-weaker-base per row', () => {
		// Each row gets a <line class="row-hairline"> spanning the chart width.
		expect(gantt).toContain('class="row-hairline"');
		expect(gantt).toContain('x2={chartWidth}');
		const hairlineRule = gantt.match(/\.row-hairline\s*\{[^}]*\}/)?.[0] ?? '';
		expect(hairlineRule).toContain('stroke: var(--border-weaker-base)');
	});

	test('SVG row emphasis: hover weak, selected base + accent, no zebra', () => {
		// Row background rect with state-driven classes.
		expect(gantt).toContain('class="row-bg"');
		expect(gantt).toContain('class:hovered={hoveredNodeId === row.node.sessionId}');
		expect(gantt).toContain('class:active={row.active}');
		// CSS: transparent base, weak on hover, base on active.
		const rowBgRule = gantt.match(/\.row-bg\s*\{[^}]*\}/)?.[0] ?? '';
		expect(rowBgRule).toContain('fill: transparent');
		const rowHoveredRule = gantt.match(/\.row-bg\.hovered\s*\{[^}]*\}/)?.[0] ?? '';
		expect(rowHoveredRule).toContain('fill: var(--surface-interactive-weak)');
		const rowActiveRule = gantt.match(/\.row-bg\.active\s*\{[^}]*\}/)?.[0] ?? '';
		expect(rowActiveRule).toContain('fill: var(--surface-interactive-base)');
		// Selected row gets a 2px left accent.
		expect(gantt).toContain('class="row-accent"');
		expect(gantt).toContain('width="2"');
		const accentRule = gantt.match(/\.row-accent\s*\{[^}]*\}/)?.[0] ?? '';
		expect(accentRule).toContain('fill: var(--border-selected)');
	});

	test('axis header band: full-width --background-stronger fill + --border-weak-base bottom border', () => {
		// SVG rect and line for the axis band.
		expect(gantt).toContain('class="axis-band"');
		expect(gantt).toContain('class="axis-band-border"');
		const bandRule = gantt.match(/\.axis-band\s*\{[^}]*\}/)?.[0] ?? '';
		expect(bandRule).toContain('fill: var(--background-stronger)');
		const borderRule = gantt.match(/\.axis-band-border\s*\{[^}]*\}/)?.[0] ?? '';
		expect(borderRule).toContain('stroke: var(--border-weak-base)');
	});

	test('.axis-spacer mirrors the SVG axis band (stronger bg + bottom border)', () => {
		const spacerRule = gantt.match(/\.axis-spacer\s*\{[\s\S]*?\}/)?.[0] ?? '';
		expect(spacerRule).toContain('background: var(--background-stronger)');
		expect(spacerRule).toContain('border-bottom: 1px solid var(--border-weak-base)');
	});

	test('tickAnchor switches to start/end within TICK_EDGE of the plot edges', () => {
		expect(gantt).toContain('function tickAnchor(px: number)');
		expect(gantt).toContain("if (px - INSET < TICK_EDGE) return 'start'");
		expect(gantt).toContain("if (chartWidth - INSET - px < TICK_EDGE) return 'end'");
		expect(gantt).toContain("return 'middle'");
		// Ticks use the anchor function.
		expect(gantt).toContain('text-anchor={tickAnchor(x(tick))}');
	});

	test('cursor time math inverts the inset transform and clamps to the band', () => {
		// Pointer move clamps x to [INSET, chartWidth - INSET].
		expect(gantt).toContain('Math.max(INSET, Math.min(right, event.clientX - rect.left))');
		expect(gantt).toContain('const right = Math.max(INSET, chartWidth - INSET)');
		// cursorT inverts the same x() transform: x = INSET + (t - extent.start) * pxPerMs
		// => t = extent.start + (x - INSET) / pxPerMs
		expect(gantt).toContain('cursorT = extent.start + (x - INSET) / pxPerMs');
		// x(time) also uses the inset: x = INSET + (time - extent.start) * pxPerMs
		expect(gantt).toContain('return INSET + (time - extent.start) * pxPerMs;');
	});

	test('plot width derives from chartWidth minus 2×INSET', () => {
		expect(gantt).toContain('const plotWidth = $derived(Math.max(1, chartWidth - 2 * INSET))');
		expect(gantt).toContain('const pxPerMs = $derived(plotWidth / span)');
	});

	test('axis line spans only the inset band, not the full chart width', () => {
		expect(gantt).toContain('x1={INSET}');
		expect(gantt).toContain('x2={chartWidth - INSET}');
	});
});
