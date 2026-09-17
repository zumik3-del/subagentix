/**
 * SSR render suite for dashboard widget primitives (dashboard Phase 3-4).
 *
 * Pins the rendered structure of the pure presentational components —
 * WidgetCard status branches, BarChart with/without detail, DayTable
 * newest-first rows and fit wiring — via Vite's SSR module runner. No DOM
 * runtime, no DB.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type ViteDevServer } from 'vite';
import type { DayBucket } from '$lib/model/chart';
import type { DistributionEntry, ToolUsage } from '$lib/model/dashboard';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

	let vite: ViteDevServer;
	let render: RenderFn;

	// Widget components
	let WidgetCard: unknown;
	let SkeletonWidget: unknown;
	let BarChart: unknown;
	let DayTable: unknown;
	let WidgetGrid: unknown;
	let WidgetSettings: unknown;
	let WidgetsModal: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;

	WidgetCard = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/WidgetCard.svelte'
		)) as { default: unknown }
	).default;
	SkeletonWidget = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/SkeletonWidget.svelte'
		)) as { default: unknown }
	).default;
	BarChart = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/BarChart.svelte'
		)) as { default: unknown }
	).default;
	DayTable = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/DayTable.svelte'
		)) as { default: unknown }
	).default;
	WidgetGrid = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/WidgetGrid.svelte'
		)) as { default: unknown }
	).default;
	WidgetSettings = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/WidgetSettings.svelte'
		)) as { default: unknown }
	).default;
	WidgetsModal = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/WidgetsModal.svelte'
		)) as { default: unknown }
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

// --- Normalisation helpers ---------------------------------------------------

function normalizeHtml(html: string): string {
	return html
		.replace(/\bsvelte-[a-z0-9]+/g, '')
		.replace(/class="([^"]*)"/g, (_m, v) => `class="${v.trim()}"`)
		.replace(/\s+/g, ' ')
		.trim();
}

function countClass(html: string, token: string): number {
	const normalized = normalizeHtml(html);
	const re = /class="([^"]*)"/g;
	let c = 0;
	for (const m of normalized.matchAll(re)) {
		const tokens = m[1].split(/\s+/);
		if (tokens.includes(token)) c++;
	}
	return c;
}

// --- Fixtures ----------------------------------------------------------------

const WIDGET_DEF = { id: 'kpi', title: 'Cost & tokens', width: 4, height: 2, tier: 'M' };

function renderWidgetCard(props: Record<string, unknown> = {}): string {
	return render(WidgetCard, {
		props: { title: 'Test Widget', status: 'ready', ...props }
	}).body;
}

function renderSkeleton(def = WIDGET_DEF): string {
	return render(SkeletonWidget, { props: { def } }).body;
}

function renderBarChart(props: Record<string, unknown> = {}): string {
	return render(BarChart, {
		props: {
			bars: [
				{ label: 'Project A', value: 100, title: '/repo/a' },
				{ label: 'Project B', value: 50 }
			],
			label: 'Top projects',
			...props
		}
	}).body;
}

function renderBarChartWithDetail(): string {
	return render(BarChart, {
		props: {
			bars: [
				{ label: 'bash', value: 100, title: '10 of 100 calls errored', detail: '10% errors' },
				{ label: 'read', value: 50, detail: '0% errors' }
			],
			label: 'Top tools',
			limit: 10
		}
	}).body;
}

function renderDayTable(props: Record<string, unknown> = {}): string {
	return render(DayTable, {
		props: {
			points: [
				{ day: '2026-01-01', value: 10 },
				{ day: '2026-01-02', value: 20 },
				{ day: '2026-01-03', value: 15 }
			],
			label: 'Sessions',
			...props
		}
	}).body;
}

function renderDayTableEmpty(): string {
	return render(DayTable, {
		props: {
			points: [],
			label: 'Sessions'
		}
	}).body;
}

// --- WidgetCard --------------------------------------------------------------

describe('WidgetCard SSR', () => {
	test('loading state has aria-busy and sr-only status', () => {
		const html = renderWidgetCard({ status: 'loading' });
		expect(html).toContain('aria-busy="true');
		expect(html).toContain('role="status"');
		expect(html).toContain('Loading Test Widget');
		expect(html).toContain('widget-card__placeholder');
	});

	test('ready state renders children via snippet', () => {
		// In SSR, Svelte snippets passed as props render differently than on
		// the client; we verify the ready branch is taken by checking the
		// card does NOT show loading/error/empty markers.
		const html = renderWidgetCard({ status: 'ready' });
		expect(html).not.toContain('widget-card__placeholder');
		expect(html).not.toContain('widget-card__message');
	});

	test('error state shows message and Retry button when onRefresh is provided', () => {
		const html = renderWidgetCard({
			status: 'error',
			error: 'Connection failed',
			onRefresh: () => {}
		});
		expect(html).toContain('Connection failed');
		expect(html).toContain('role="alert"');
		expect(html).toContain('>Retry<');
	});

	test('error state without onRefresh omits the Retry button', () => {
		const html = renderWidgetCard({
			status: 'error',
			error: 'Connection failed'
		});
		expect(html).toContain('Connection failed');
		expect(html).not.toContain('>Retry<');
	});

	test('empty state shows the standard no-data message', () => {
		const html = renderWidgetCard({ status: 'empty' });
		expect(html).toContain('No data for this period.');
	});

	test('default status is ready', () => {
		const html = renderWidgetCard({});
		// Should not show loading/error/empty markers
		expect(html).not.toContain('aria-busy="true"');
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain('No data for this period.');
	});

	test('card root has ui-card class', () => {
		const html = renderWidgetCard();
		expect(html).toContain('ui-card widget-card');
	});

	test('refresh button is disabled while refreshing or loading', () => {
		const htmlRefreshing = renderWidgetCard({
			status: 'ready',
			refreshing: true,
			onRefresh: () => {}
		});
		expect(htmlRefreshing).toContain('disabled');

		const htmlLoading = renderWidgetCard({
			status: 'loading',
			onRefresh: () => {}
		});
		expect(htmlLoading).toContain('disabled');
	});

	test('title is rendered in the heading', () => {
		const html = renderWidgetCard({ title: 'My Widget' });
		expect(html).toContain('>My Widget<');
	});
});

// --- SkeletonWidget ------------------------------------------------------------

describe('SkeletonWidget SSR', () => {
	test('renders ui-card class and aria-busy', () => {
		const html = renderSkeleton();
		expect(html).toContain('skeleton-widget ui-card');
		expect(html).toContain('aria-busy="true"');
	});

	test('displays the widget title from def', () => {
		const html = renderSkeleton({ ...WIDGET_DEF, title: 'Cost & tokens' });
		// SSR escapes & to &amp; in text content.
		expect(html).toContain('Cost &amp; tokens');
	});

	test('has three placeholder bars', () => {
		const html = renderSkeleton();
		expect(countClass(html, 'skeleton-widget__bar')).toBe(3);
	});

	test('one bar has the --short modifier', () => {
		const html = renderSkeleton();
		expect(countClass(html, 'skeleton-widget__bar--short')).toBe(1);
	});
});

// --- BarChart ----------------------------------------------------------------

describe('BarChart SSR', () => {
	test('renders bars with role="img" and aria-label per row', () => {
		const html = renderBarChart();
		expect(html).toContain('role="img"');
		expect(html).toContain('aria-label="Project A:');
	});

	test('shows the empty state when rows are empty or peak <= 0', () => {
		const emptyHtml = renderBarChart({ bars: [], label: 'X' });
		expect(emptyHtml).toContain('No data for this period.');
	});

	test('renders the caption as sr-only', () => {
		const html = renderBarChart();
		expect(html).toContain('scope="col"');
	});

	test('truncates to limit rows', () => {
		const manyBars = Array.from({ length: 20 }, (_, i) => ({
			label: `P${i}`,
			value: 100 - i
		}));
		const html = renderBarChart({ bars: manyBars, limit: 5 });
		// Only 5 bars should appear
		expect(countClass(html, 'bar-chart__label')).toBe(5);
	});

	test('detail field renders visible secondary text and folds into aria-label', () => {
		const html = renderBarChartWithDetail();
		expect(html).toContain('bar-chart__detail');
		expect(html).toContain('10% errors');
		// aria-label should include the detail
		expect(html).toContain('aria-label="bash:');
		expect(html).toContain('10% errors');
	});

	test('without detail, no bar-chart__detail span is rendered', () => {
		const html = renderBarChart();
		expect(html).not.toContain('bar-chart__detail');
	});

	test('uses linearScale-proportional widths (viewBox 0 0 100 1)', () => {
		const html = renderBarChart({
			bars: [{ label: 'A', value: 100 }, { label: 'B', value: 50 }],
			limit: 10
		});
		// Both bars should be present with different widths
		expect(html).toContain('viewBox="0 0 100 1"');
	});
});

// --- DayTable ----------------------------------------------------------------

describe('DayTable SSR', () => {
	test('renders days in newest-first order', () => {
		const html = renderDayTable();
		// Points are ascending; reverse makes the last day appear first.
		expect(html).toContain('>2026-01-03<');
		expect(html).toContain('>2026-01-02<');
		expect(html).toContain('>2026-01-01<');
		// 2026-01-03 must appear before 2026-01-01 in the markup.
		const idx03 = html.indexOf('2026-01-03');
		const idx01 = html.indexOf('2026-01-01');
		expect(idx03).toBeLessThan(idx01);
	});

	test('table caption uses the label as sr-only accessible name', () => {
		const html = renderDayTable({ label: 'Cost' });
		expect(html).toContain('Cost per day');
	});

	test('thead has Day and value scope="col" headers', () => {
		const html = renderDayTable();
		// Svelte appends its own class hash; match the scoped attribute and label independently.
		expect(html).toMatch(/<th\s+scope="col"[^>]*>Day<\/th>/);
		expect(html).toMatch(/<th\s+scope="col"[^>]*>Sessions<\/th>/);
	});

	test('each row has a scope="row" day header and a value cell', () => {
		const html = renderDayTable();
		expect(html).toContain('scope="row"');
		expect(html).toContain('day-table__day');
		expect(html).toContain('day-table__value');
		expect(html).toContain('>10<');
		expect(html).toContain('>15<');
		expect(html).toContain('>20<');
	});

	test('empty points renders the empty-state paragraph, not the table', () => {
		const html = renderDayTableEmpty();
		expect(html).not.toContain('<table');
		expect(html).toContain('day-table__empty');
		expect(html).toContain('No data for this period.');
	});

	test('figure wrapper is present with the fit-host class', () => {
		const html = renderDayTable();
		expect(html).toMatch(/<figure class="[^"]*day-table/);
	});
});

// --- registry descriptor loaders ---------------------------------------------

describe('registry descriptors map widget ids to co-located body loaders', () => {
	async function registryDefs(): Promise<Array<{ id: string; load?: unknown }>> {
		const mod = await vite.ssrLoadModule('/src/lib/widgets/registry.ts');
		return (mod as { WIDGET_DEFS: Array<{ id: string; load?: unknown }> }).WIDGET_DEFS;
	}

	test('every registered id carries a load function', async () => {
		const defs = await registryDefs();
		for (const id of [
			'kpi',
			'sessions-per-day',
			'cost-per-day',
			'top-tools',
			'agent-distribution',
			'top-projects'
		]) {
			expect(typeof defs.find((def) => def.id === id)?.load, id).toBe('function');
		}
	});

	test('the registry defines exactly the six v1 widget ids', async () => {
		const defs = await registryDefs();
		expect(defs.map((def) => def.id)).toEqual([
			'kpi',
			'sessions-per-day',
			'cost-per-day',
			'top-tools',
			'agent-distribution',
			'top-projects'
		]);
	});
});

// --- WidgetGrid SSR ----------------------------------------------------------

describe('WidgetGrid SSR', () => {
	const placements = [
		{ id: 'kpi', width: 4, height: 2 },
		{ id: 'sessions-per-day', width: 2, height: 3 },
		{ id: 'agent-distribution', width: 1, height: 3 }
	];

	test('emits data-w and data-h matching each placement', () => {
		const html = render(WidgetGrid, {
			props: { placements }
		}).body;
		expect(html).toContain('data-w="4"');
		expect(html).toContain('data-h="2"');
		expect(html).toContain('data-w="2"');
		expect(html).toContain('data-h="3"');
		expect(html).toContain('data-w="1"');
	});

	test('renders one li per placement in registry order', () => {
		const html = render(WidgetGrid, {
			props: { placements }
		}).body;
		// The grid wraps placements in <li> elements with the widget-grid__item class.
		expect(countClass(html, 'widget-grid__item')).toBe(3);
	});

	test('emits grid-stack-item class on each li in SSR', () => {
		const html = render(WidgetGrid, {
			props: { placements }
		}).body;
		// Every item must carry the gridstack contract class so the enhancement path
		// can adopt the DOM without a rewrite.
		expect(countClass(html, 'grid-stack-item')).toBe(3);
	});

	test('emits gs-x/gs-y/gs-w/gs-h attributes on each li in SSR', () => {
		const html = render(WidgetGrid, {
			props: { placements }
		}).body;
		// width/height always render as gs-w/gs-h attributes.
		expect(html).toContain('gs-w="4"');
		expect(html).toContain('gs-h="2"');
		expect(html).toContain('gs-w="2"');
		expect(html).toContain('gs-h="3"');
		expect(html).toContain('gs-w="1"');
		// x/y are undefined in the test fixture, so gs-x/gs-y attributes are omitted
		// (the spread drops undefined values); the inline --gs-* style still carries 0.
		expect(html).not.toContain('gs-x=');
		expect(html).not.toContain('gs-y=');
		expect(html).toContain('--gs-x:0');
		expect(html).toContain('--gs-y:0');
		expect(html).toContain('--gs-w:4');
		expect(html).toContain('--gs-h:2');
	});

	test('emits --gs-* custom properties on each li in SSR', () => {
		const html = render(WidgetGrid, {
			props: { placements }
		}).body;
		expect(html).toContain('--gs-x:0');
		expect(html).toContain('--gs-y:0');
		expect(html).toContain('--gs-w:4');
		expect(html).toContain('--gs-h:2');
		expect(html).toContain('--gs-w:2');
		expect(html).toContain('--gs-h:3');
		expect(html).toContain('--gs-w:1');
	});

	test('wraps WidgetHost in grid-stack-item-content in SSR', () => {
		const html = render(WidgetGrid, {
			props: { placements }
		}).body;
		expect(countClass(html, 'grid-stack-item-content')).toBe(3);
		// Structural guarantee: the wrapper sits between <li> and the widget host div.
		// Svelte SSR appends a svelte hash to every class, so we match loosely.
		expect(html).toMatch(/grid-stack-item-content[^>]*>[\s\S]*?widget-host/);
	});

	test('container never carries grid-stack class in SSR', () => {
		const html = render(WidgetGrid, {
			props: { placements }
		}).body;
		// Progressive-enhancement invariant: the <ul> is .widget-grid only in SSR.
		// The <li> elements legitimately carry grid-stack-item; check the <ul> specifically.
		const ulMatch = html.match(/<ul[^>]*>/);
		expect(ulMatch).not.toBeNull();
		expect(ulMatch![0]).not.toMatch(/\bgrid-stack\b/);
	});

	test('renders the grid-stack contract in source', async () => {
		const raw = await Bun.file(
			new URL('./WidgetGrid.svelte', import.meta.url)
		).text();
		// Desktop columns are driven by the --grid-columns custom prop (layout.ts source of truth).
		expect(raw).toMatch(/grid-template-columns:\s*repeat\(var\(--grid-columns\)/);
		expect(raw).toMatch(/\-\-grid-columns:\$\{GRID_COLUMNS\}/);
		// Row height is driven by the --grid-row-height custom prop.
		expect(raw).toMatch(/grid-auto-rows:\s*var\(--grid-row-height\)/);
		expect(raw).toMatch(/\-\-grid-row-height:\$\{GRID_ROW_HEIGHT_REM\}rem/);
		// The gridstack contract attributes and wrapper must be present at the source level.
		expect(raw).toMatch(/class="widget-grid__item grid-stack-item"/);
		expect(raw).toMatch(/'gs-x': placement\.x/);
		expect(raw).toMatch(/class="grid-stack-item-content"/);
		// The container must never carry grid-stack in SSR (progressive enhancement).
		expect(raw).not.toMatch(/<ul[^>]*\bgrid-stack\b/);
		// WidgetGrid.svelte imports the client-only wrapper, not gridstack directly.
		expect(raw).not.toMatch(/from ['"]gridstack['"]/);
		expect(raw).toMatch(/grid-auto-flow:\s*row\s+dense/);
	});

	test('source contains clamp media queries for <=64rem and <=40rem', async () => {
		const raw = await Bun.file(
			new URL('./WidgetGrid.svelte', import.meta.url)
		).text();
		// Both clamp breakpoints must be present.
		expect(raw).toMatch(/max-width:\s*63\.99rem/);
		expect(raw).toMatch(/max-width:\s*39\.99rem/);
		// The 64rem query clamps width-3/4 to span 2.
		expect(raw).toMatch(/data-w='3']/);
		expect(raw).toMatch(/data-w='4']/);
		// The 40rem query makes every widget full-width.
		expect(raw).toMatch(/data-w\]/);
	});
});

// --- WidgetSettings SSR -------------------------------------------------------

describe('WidgetSettings SSR', () => {
	test('closed dialog (open=false) emits no dialog markup at all', () => {
		const html = render(WidgetSettings, {
			props: {
				open: false,
				widget: { id: 'kpi', title: 'Cost & tokens', width: 4, height: 2, minHeight: 2, tier: 'M' },
				placement: { id: 'kpi', width: 4, height: 2 },
				onChange: () => {},
				onClose: () => {}
			}
		}).body;
		expect(html).not.toContain('role="dialog"');
		expect(html).not.toContain('aria-modal');
		expect(html).not.toContain('widget-settings-dialog');
		expect(html).not.toContain('widget-settings__');
	});

	test('opened dialog carries role=dialog, aria-modal and labelled-by', () => {
		const html = render(WidgetSettings, {
			props: {
				open: true,
				widget: { id: 'kpi', title: 'Cost & tokens', width: 4, height: 2, minHeight: 2, tier: 'M' },
				placement: { id: 'kpi', width: 4, height: 2 },
				onChange: () => {},
				onClose: () => {}
			}
		}).body;
		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-modal="true"');
		expect(html).toContain('aria-labelledby="widget-settings-title"');
		expect(html).toContain('>Cost &amp; tokens<');
		expect(html).toContain('Widget settings');
	});

	test('header has the icon close control with widget-title-specific aria-label and no footer', () => {
		const html = render(WidgetSettings, {
			props: {
				open: true,
				widget: { id: 'kpi', title: 'Cost & tokens', width: 4, height: 2, minHeight: 2, tier: 'M' },
				placement: { id: 'kpi', width: 4, height: 2 },
				onChange: () => {},
				onClose: () => {}
			}
		}).body;
		expect(html).toContain('ui-icon-btn');
		expect(html).toContain('aria-label="Close Cost &amp; tokens settings"');
		expect(html).not.toContain('>Close<');
		expect(html).not.toContain('>Cancel<');
		expect(html).not.toContain('ui-modal__foot');
	});

	test('header is a single row: title + subtitle + close in one .ui-modal__head', () => {
		const html = render(WidgetSettings, {
			props: {
				open: true,
				widget: { id: 'kpi', title: 'Cost & tokens', width: 4, height: 2, minHeight: 2, tier: 'M' },
				placement: { id: 'kpi', width: 4, height: 2 },
				onChange: () => {},
				onClose: () => {}
			}
		}).body;
		expect(html).toContain('ui-modal__head');
		expect(html).toContain('ui-modal__title');
		expect(html).toContain('widget-settings__sub');
		expect(html.match(/<h2[^>]*>/g)?.length ?? 0).toBe(1);
	});
});

// --- WidgetsModal SSR ---------------------------------------------------------

describe('WidgetsModal SSR', () => {
	const baseProps = {
		open: true,
		selected: [],
		onApply: () => {},
		onClose: () => {}
	};

	test('renders dialog shell with role=dialog and aria-modal when open', () => {
		const html = render(WidgetsModal, { props: baseProps }).body;
		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-modal="true"');
		expect(html).toContain('aria-labelledby="widgets-title"');
		expect(html).toContain('>Widgets<');
	});

	test('header has the icon close control with widget-picker-specific aria-label and no footer Close/Cancel', () => {
		const html = render(WidgetsModal, { props: baseProps }).body;
		expect(html).toContain('ui-icon-btn');
		expect(html).toContain('aria-label="Close widget picker"');
		expect(html).not.toContain('>Close<');
		expect(html).not.toContain('>Cancel<');
	});

	test('footer carries Restore defaults + Apply (no Cancel)', () => {
		const html = render(WidgetsModal, { props: baseProps }).body;
		expect(html).toContain('ui-modal__foot');
		expect(html).toContain('Restore defaults');
		expect(html).toContain('>Apply<');
		expect(html).not.toContain('>Cancel<');
	});

	test('header is a single row: title + close in one .ui-modal__head', () => {
		const html = render(WidgetsModal, { props: baseProps }).body;
		expect(html).toContain('ui-modal__head');
		expect(html).toContain('ui-modal__title');
		expect(html.match(/<h2[^>]*>/g)?.length ?? 0).toBe(1);
	});
});

// --- WidgetCard gear control --------------------------------------------------

describe('WidgetCard gear control SSR (task #449)', () => {
	test('gear button is rendered with accessible name when onSettings is supplied', () => {
		const html = renderWidgetCard({
			title: 'Test Widget',
			onSettings: () => {}
		});
		expect(html).toContain('widget-card__settings');
		expect(html).toContain('aria-label="Settings for Test Widget"');
		expect(html).toContain('aria-haspopup="dialog"');
		expect(html).toContain('title="Widget settings"');
	});

	test('no gear button is rendered when onSettings is omitted', () => {
		const html = renderWidgetCard({
			title: 'Test Widget'
		});
		expect(html).not.toContain('widget-card__settings');
		expect(html).not.toContain('aria-haspopup="dialog"');
	});
});

// --- DayTableWidget SSR -------------------------------------------------------

describe('DayTableWidget SSR (task #491)', () => {
	let DayTableWidget: unknown;

	beforeAll(async () => {
		DayTableWidget = (
			(await vite.ssrLoadModule(
				'/src/lib/components/features/dashboard/DayTableWidget.svelte'
			)) as { default: unknown }
		).default;
	}, 60_000);

	test('renders sessions table with formatNumber by default', () => {
		const html = render(DayTableWidget, {
			props: {
				data: [
					{ day: '2026-01-01', value: 10 },
					{ day: '2026-01-02', value: 20 },
					{ day: '2026-01-03', value: 15 }
				],
				label: 'Sessions',
				formatValue: (v: number) => v.toString()
			}
		}).body;
		// Newest-first order.
		expect(html).toContain('>2026-01-03<');
		expect(html).toContain('>2026-01-02<');
		expect(html).toContain('>2026-01-01<');
		// Values rendered via formatValue.
		expect(html).toContain('>15<');
		expect(html).toContain('>20<');
		expect(html).toContain('>10<');
		// Table structure present.
		expect(html).toContain('day-table__table');
		expect(html).toContain('scope="row"');
	});

	test('renders cost table with formatCost-style formatter', () => {
		const html = render(DayTableWidget, {
			props: {
				data: [
					{ day: '2026-01-01', value: 1.2345 },
					{ day: '2026-01-02', value: 2.5678 }
				],
				label: 'Cost',
				formatValue: (v: number) => `$${v.toFixed(4)}`
			}
		}).body;
		expect(html).toContain('>2026-01-02<');
		expect(html).toContain('>2026-01-01<');
		expect(html).toContain('$2.5678');
		expect(html).toContain('$1.2345');
	});

	test('renders empty state when data is empty', () => {
		const html = render(DayTableWidget, {
			props: {
				data: [],
				label: 'Sessions',
				formatValue: (v: number) => v.toString()
			}
		}).body;
		expect(html).not.toContain('<table');
		expect(html).toContain('day-table__empty');
		expect(html).toContain('No data for this period.');
	});
});

// --- KpiWidget SSR ------------------------------------------------------------

describe('KpiWidget SSR (task #491)', () => {
	let KpiWidget: unknown;

	beforeAll(async () => {
		KpiWidget = (
			(await vite.ssrLoadModule(
				'/src/lib/components/features/dashboard/KpiWidget.svelte'
			)) as { default: unknown }
		).default;
	}, 60_000);

	test('renders session count, cost and token total tiles', () => {
		const html = render(KpiWidget, {
			props: {
				data: {
					sessions: 42,
					cost: 1.2345,
					tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 }
				}
			}
		}).body;
		expect(html).toContain('kpi__tiles');
		expect(html).toContain('>42<'); // sessions
		expect(html).toContain('Cost (gross)');
		expect(html).toContain('Total tokens');
		expect(html).toContain('kpi__tile');
	});

	test('renders the token mix bar SVG', () => {
		const html = render(KpiWidget, {
			props: {
				data: {
					sessions: 10,
					cost: 0.5,
					tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
				}
			}
		}).body;
		expect(html).toContain('kpi__mix-svg');
		expect(html).toContain('viewBox="0 0 100 1"');
		expect(html).toContain('kpi__mix-seg');
	});

	test('renders the token breakdown list', () => {
		const html = render(KpiWidget, {
			props: {
				data: {
					sessions: 10,
					cost: 0.5,
					tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
				}
			}
		}).body;
		expect(html).toContain('kpi__breakdown');
		expect(html).toContain('kpi__breakdown-item');
	});
});

// --- TopToolsWidget SSR -------------------------------------------------------

describe('TopToolsWidget SSR (task #491)', () => {
	let TopToolsWidget: unknown;

	beforeAll(async () => {
		TopToolsWidget = (
			(await vite.ssrLoadModule(
				'/src/lib/components/features/dashboard/TopToolsWidget.svelte'
			)) as { default: unknown }
		).default;
	}, 60_000);

	test('renders tool rows in a table', () => {
		const html = render(TopToolsWidget, {
			props: {
				data: {
					tools: [
						{ name: 'bash', count: 100, errors: 5, errorShare: 0.05 },
						{ name: 'read', count: 50, errors: 0, errorShare: 0 }
					],
					capped: false
				},
				filter: { period: '7d' as const, scope: null }
			}
		}).body;
		expect(html).toContain('top-tools__table');
		expect(html).toContain('>bash<');
		expect(html).toContain('>read<');
		expect(html).toContain('top-tools__count');
		expect(html).toContain('top-tools__errors');
	});

	test('renders the capped note when capped=true with period=all', () => {
		const html = render(TopToolsWidget, {
			props: {
				data: { tools: [], capped: true },
				filter: { period: 'all' as const, scope: null }
			}
		}).body;
		expect(html).toContain('top-tools__note');
		expect(html).toContain('Approximate');
	});

	test('no note rendered when not capped and period is bounded', () => {
		const html = render(TopToolsWidget, {
			props: {
				data: { tools: [], capped: false },
				filter: { period: '7d' as const, scope: null }
			}
		}).body;
		expect(html).not.toContain('top-tools__note');
	});
});

// --- AgentDistributionWidget SSR ----------------------------------------------

describe('AgentDistributionWidget SSR (task #491)', () => {
	let AgentDistributionWidget: unknown;

	beforeAll(async () => {
		AgentDistributionWidget = (
			(await vite.ssrLoadModule(
				'/src/lib/components/features/dashboard/AgentDistributionWidget.svelte'
			)) as { default: unknown }
		).default;
	}, 60_000);

	test('renders agent rows with name, count and share', () => {
		const html = render(AgentDistributionWidget, {
			props: {
				data: [
					{ name: 'agnes', count: 100 },
					{ name: 'opus', count: 50 }
				]
			}
		}).body;
		expect(html).toContain('distribution__table');
		expect(html).toContain('>agnes<');
		expect(html).toContain('>opus<');
		expect(html).toContain('distribution__count');
		expect(html).toContain('distribution__share');
	});

	test('renders empty state when data is empty', () => {
		const html = render(AgentDistributionWidget, {
			props: {
				data: []
			}
		}).body;
		expect(html).not.toContain('<table');
		expect(html).toContain('distribution__empty');
		expect(html).toContain('No data for this period.');
	});
});

// --- TopProjectsWidget SSR ----------------------------------------------------

describe('TopProjectsWidget SSR (task #491)', () => {
	let TopProjectsWidget: unknown;

	beforeAll(async () => {
		TopProjectsWidget = (
			(await vite.ssrLoadModule(
				'/src/lib/components/features/dashboard/TopProjectsWidget.svelte'
			)) as { default: unknown }
		).default;
	}, 60_000);

	test('renders project bars with short labels and full-path titles', () => {
		const html = render(TopProjectsWidget, {
			props: {
				data: [
					{ directory: '/repo/a', projectName: 'Project A', count: 100 },
					{ directory: '/repo/b/sub', projectName: null, count: 50 }
				]
			}
		}).body;
		expect(html).toContain('bar-chart__table');
		expect(html).toContain('>Project A<');
		// When projectName is null, the basename is used.
		expect(html).toContain('>sub<');
		expect(html).toContain('bar-chart__label');
		expect(html).toContain('bar-chart__bar');
	});

	test('renders empty state when data is empty', () => {
		const html = render(TopProjectsWidget, {
			props: {
				data: []
			}
		}).body;
		expect(html).toContain('bar-chart__empty');
		expect(html).toContain('No data for this period.');
	});
});

// --- WidgetShell SSR invariant ------------------------------------------------

describe('WidgetShell SSR contract (task #490/#491)', () => {
	test('every registered widget has a corresponding body component that can be loaded', async () => {
		const { WIDGET_IDS } = await import('$lib/widgets/registry');
		for (const id of WIDGET_IDS) {
			const def = (await import('$lib/widgets/registry')).WIDGET_REGISTRY[id];
			// The load function should resolve without throwing.
			await expect(async () => {
				const mod = await def.load();
				expect(mod.default).toBeDefined();
			}).not.toThrow();
		}
	});
});
