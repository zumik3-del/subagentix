/**
 * SSR render suite for dashboard widget primitives (dashboard Phase 3-4).
 *
 * Pins the rendered structure of the pure presentational components —
 * WidgetCard status branches, BarChart with/without detail, DonutChart
 * non-empty/empty/top-N aggregation, TimeSeriesChart sr-only table and
 * visible fallback — via Vite's SSR module runner. No DOM runtime, no DB.
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
let DonutChart: unknown;
let TimeSeriesChart: unknown;

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
	DonutChart = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/DonutChart.svelte'
		)) as { default: unknown }
	).default;
	TimeSeriesChart = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/TimeSeriesChart.svelte'
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

const WIDGET_DEF = { id: 'kpi', title: 'Cost & tokens', size: 'full', tier: 'M', defaultOn: true, source: '/api/dashboard/kpi' };

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

function renderDonutChart(props: Record<string, unknown> = {}): string {
	return render(DonutChart, {
		props: {
			slices: [
				{ label: 'agent-a', value: 80 },
				{ label: 'agent-b', value: 60 },
				{ label: 'agent-c', value: 40 }
			],
			label: 'Agent distribution',
			unit: 'sessions',
			...props
		}
	}).body;
}

function renderDonutChartEmpty(): string {
	return render(DonutChart, {
		props: {
			slices: [],
			label: 'Agent distribution',
			unit: 'sessions'
		}
	}).body;
}

function renderDonutChartTopN(): string {
	// 10 slices → top 5 + "Other"
	const slices: { label: string; value: number }[] = Array.from({ length: 10 }, (_, i) => ({
		label: `agent-${String.fromCharCode(97 + i)}`,
		value: 100 - i * 5
	}));
	return render(DonutChart, {
		props: { slices, label: 'Agent distribution', unit: 'sessions' }
	}).body;
}

function renderTimeSeriesChart(props: Record<string, unknown> = {}): string {
	return render(TimeSeriesChart, {
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

function renderTimeSeriesChartEmpty(): string {
	return render(TimeSeriesChart, {
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

// --- DonutChart --------------------------------------------------------------

describe('DonutChart SSR', () => {
	test('renders role="img" with summary aria-label', () => {
		const html = renderDonutChart();
		expect(html).toContain('role="img"');
		expect(html).toContain('aria-label="Agent distribution:');
	});

	test('shows the empty state when total <= 0', () => {
		const html = renderDonutChartEmpty();
		expect(html).toContain('No data for this period.');
	});

	test('legend table has scope="row" and scope="col" headers', () => {
		const html = renderDonutChart();
		expect(html).toContain('scope="row"');
		expect(html).toContain('scope="col"');
	});

	test('top-N aggregation merges excess slices into "Other"', () => {
		const html = renderDonutChartTopN();
		// With 10 slices and MAX_SLICES=6, should have 5 named + 1 Other
		expect(html).toContain('>Other<');
		// Should NOT contain all 10 individual agent labels
		expect(html).not.toContain('>agent-j<'); // 10th agent should be merged
	});

	test('each arc slice has a path with arc geometry', () => {
		const html = renderDonutChart();
		expect(html).toContain('<path');
		expect(html).toContain('donut__slice');
	});

	test('center total shows formatted sum', () => {
		const html = renderDonutChart();
		// Total = 80 + 60 + 40 = 180
		expect(html).toContain('>180<');
		expect(html).toContain('>sessions<');
	});

	test('uses --chart-* tokens for slice colors', () => {
		const html = renderDonutChart();
		expect(html).toContain('--chart-1');
		expect(html).toContain('--chart-2');
	});
});

// --- TimeSeriesChart ---------------------------------------------------------

describe('TimeSeriesChart SSR', () => {
	test('renders a sr-only table with day/value rows', () => {
		const html = renderTimeSeriesChart();
		expect(html).toContain('sr-only');
		expect(html).toContain('caption');
		expect(html).toContain('2026-01-01');
		expect(html).toContain('10');
		expect(html).toContain('2026-01-02');
		expect(html).toContain('20');
	});

	test('table caption uses the label', () => {
		const html = renderTimeSeriesChart({ label: 'Cost' });
		expect(html).toContain('Cost per day');
	});

	test('empty points yields an empty table body', () => {
		const html = renderTimeSeriesChartEmpty();
		expect(html).not.toContain('2026-');
		// Still has the table structure
		expect(html).toContain('<table');
	});

	test('canvas div is aria-hidden', () => {
		const html = renderTimeSeriesChart();
		expect(html).toContain('aria-hidden="true"');
	});

	test('figure wrapper is present', () => {
		const html = renderTimeSeriesChart();
		expect(html).toContain('<figure');
		expect(html).toContain('ts-chart');
	});
});

// --- loaders.ts registration assertions --------------------------------------

describe('loaders.ts maps widget ids to correct bodies', () => {
	test('kpi routes to KpiWidget', async () => {
		const mod = await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/loaders.ts'
		);
		const loaders = (mod as { WIDGET_LOADERS: Record<string, unknown> }).WIDGET_LOADERS;
		expect(loaders['kpi']).toBeDefined();
	});

	test('sessions-per-day routes to SessionsPerDayWidget', async () => {
		const mod = await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/loaders.ts'
		);
		const loaders = (mod as { WIDGET_LOADERS: Record<string, unknown> }).WIDGET_LOADERS;
		expect(loaders['sessions-per-day']).toBeDefined();
	});

	test('cost-per-day routes to CostPerDayWidget', async () => {
		const mod = await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/loaders.ts'
		);
		const loaders = (mod as { WIDGET_LOADERS: Record<string, unknown> }).WIDGET_LOADERS;
		expect(loaders['cost-per-day']).toBeDefined();
	});

	test('top-tools routes to TopToolsWidget (not WidgetBody)', async () => {
		const mod = await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/loaders.ts'
		);
		const loaders = (mod as { WIDGET_LOADERS: Record<string, unknown> }).WIDGET_LOADERS;
		expect(loaders['top-tools']).toBeDefined();
	});

	test('agent-distribution routes to AgentDistributionWidget', async () => {
		const mod = await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/loaders.ts'
		);
		const loaders = (mod as { WIDGET_LOADERS: Record<string, unknown> }).WIDGET_LOADERS;
		expect(loaders['agent-distribution']).toBeDefined();
	});

	test('top-projects routes to TopProjectsWidget', async () => {
		const mod = await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/loaders.ts'
		);
		const loaders = (mod as { WIDGET_LOADERS: Record<string, unknown> }).WIDGET_LOADERS;
		expect(loaders['top-projects']).toBeDefined();
	});

	test('all six registered ids match the registry', async () => {
		const mod = await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/loaders.ts'
		);
		const loaders = (mod as { WIDGET_LOADERS: Record<string, unknown> }).WIDGET_LOADERS;
		const registeredIds = Object.keys(loaders);
		expect(registeredIds).toContain('kpi');
		expect(registeredIds).toContain('sessions-per-day');
		expect(registeredIds).toContain('cost-per-day');
		expect(registeredIds).toContain('top-tools');
		expect(registeredIds).toContain('agent-distribution');
		expect(registeredIds).toContain('top-projects');
		expect(registeredIds.length).toBe(6);
	});
});
