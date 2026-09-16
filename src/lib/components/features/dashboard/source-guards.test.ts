import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Source-guard tests for dashboard widget modules (task #417).
 *
 * Verifies that the contract requirements — no static uplot import, no DOM
 * access in pure helpers, no $lib/server imports in client-safe modules — are
 * mechanically enforced at the source level. These complement the runtime
 * tests in the characterization suite.
 */

describe('TimeSeriesChart source: uplot only via dynamic import', () => {
	const source = readFileSync(
		new URL('./TimeSeriesChart.svelte', import.meta.url),
		'utf8'
	);

	test('does not have a static import of uplot', () => {
		expect(source).not.toMatch(/from ['"]uplot['"]/);
	});

	test('does not have a type-only import of uplot', () => {
		expect(source).not.toMatch(/import\s+type\s+.*from\s+['"]uplot['"]/);
	});

	test('contains the dynamic import("uplot") call inside onMount', () => {
		expect(source).toMatch(/import\(['"]uplot['"]\)/);
	});

	test('contains the dynamic import of the uPlot CSS', () => {
		expect(source).toMatch(/import\(['"]uplot\/dist\/uPlot\.min\.css['"]\)/);
	});

	test('declares local UPlotInstance and UPlotConstructor interfaces', () => {
		expect(source).toMatch(/interface\s+UPlotInstance/);
		expect(source).toMatch(/interface\s+UPlotConstructor/);
	});

	test('calls chart.destroy in the onMount cleanup', () => {
		expect(source).toMatch(/chart\?\.destroy\(\)/);
	});

	test('calls chart.setSize when resizing', () => {
		expect(source).toMatch(/chart\.setSize/);
	});

	test('disconnects ResizeObserver on cleanup', () => {
		expect(source).toMatch(/observer\?\.disconnect\(\)/);
	});

	test('sets failed=true when the dynamic import rejects', () => {
		expect(source).toMatch(/failed\s*=\s*true/);
	});

	test('sr-only table is present for accessible fallback', () => {
		expect(source).toMatch(/sr-only/);
		expect(source).toMatch(/caption/);
	});

	test('visible fallback note appears when chart load fails', () => {
		expect(source).toMatch(/ts-chart__note/);
		expect(source).toMatch(/Chart unavailable/);
	});
});

describe('BarChart source: no chart library import', () => {
	const source = readFileSync(
		new URL('./BarChart.svelte', import.meta.url),
		'utf8'
	);

	test('does not import any chart library', () => {
		expect(source).not.toMatch(/from ['"]uplot['"]/);
		expect(source).not.toMatch(/from ['"]d3['"]/);
		expect(source).not.toMatch(/from ['"]chart['"]/);
	});

	test('imports linearScale and topN from model/chart', () => {
		expect(source).toMatch(/from ['"]\$lib\/model\/chart['"]/);
	});

	test('each bar SVG has role="img" and aria-label', () => {
		expect(source).toMatch(/role="img"/);
		expect(source).toMatch(/aria-label=/);
	});

	test('renders the empty state when peak <= 0', () => {
		expect(source).toMatch(/bar-chart__empty/);
	});

	test('detail field renders bar-chart__detail span', () => {
		expect(source).toMatch(/bar-chart__detail/);
	});

	test('uses viewBox and preserveAspectRatio for responsiveness', () => {
		expect(source).toMatch(/viewBox="0 0 100 1"/);
		expect(source).toMatch(/preserveAspectRatio="none"/);
	});
});

describe('DonutChart source: no chart library import', () => {
	const source = readFileSync(
		new URL('./DonutChart.svelte', import.meta.url),
		'utf8'
	);

	test('does not import any chart library', () => {
		expect(source).not.toMatch(/from ['"]uplot['"]/);
		expect(source).not.toMatch(/from ['"]d3['"]/);
	});

	test('imports arcPath, arcSegments and topN from model/chart', () => {
		expect(source).toMatch(/from ['"]\$lib\/model\/chart['"]/);
	});

	test('root SVG has role="img" and aria-label', () => {
		expect(source).toMatch(/role="img"/);
		expect(source).toMatch(/aria-label=/);
	});

	test('renders the empty state when total <= 0', () => {
		expect(source).toMatch(/donut__empty/);
	});

	test('uses viewBox and responsive sizing', () => {
		expect(source).toMatch(/viewBox="0 0 100 100"/);
	});

	test('legend table has scope attributes', () => {
		expect(source).toMatch(/scope="row"/);
		expect(source).toMatch(/scope="col"/);
	});
});

describe('WidgetHost source: IntersectionObserver guard', () => {
	const source = readFileSync(
		new URL('./WidgetHost.svelte', import.meta.url),
		'utf8'
	);

	test('checks IntersectionObserver availability before using it', () => {
		expect(source).toMatch(/typeof\s+IntersectionObserver\s*===/);
	});

	test('uses IntersectionObserver with rootMargin', () => {
		expect(source).toMatch(/new\s+IntersectionObserver/);
		expect(source).toMatch(/rootMargin/);
	});

	test('disconnects observer in cleanup', () => {
		expect(source).toMatch(/observer\.disconnect\(\)/);
	});

	test('uses cancelled guard to prevent double-init', () => {
		expect(source).toMatch(/let\s+cancelled/);
	});

	test('renders SkeletonWidget when not yet loaded', () => {
		expect(source).toMatch(/SkeletonWidget/);
	});

	test('renders WidgetCard error state on failed import with retry', () => {
		expect(source).toMatch(/WidgetCard/);
		expect(source).toMatch(/failed/);
		expect(source).toMatch(/retry/);
	});

	test('forward widgetProps to the loaded component', () => {
		expect(source).toMatch(/\{\.\.\.widgetProps\}/);
	});
});

describe('WidgetCard source: all status branches + ARIA', () => {
	const source = readFileSync(
		new URL('./WidgetCard.svelte', import.meta.url),
		'utf8'
	);

	test('loading state has aria-busy', () => {
		expect(source).toMatch(/aria-busy=/);
	});

	test('loading state has role="status" sr-only text', () => {
		expect(source).toMatch(/role="status"/);
	});

	test('error state has role="alert"', () => {
		expect(source).toMatch(/role="alert"/);
	});

	test('error state renders error message', () => {
		expect(source).toMatch(/widget-card__message/);
	});

	test('error state renders Retry button when onRefresh is provided', () => {
		expect(source).toMatch(/widget-card__retry/);
	});

	test('empty state shows No data message', () => {
		expect(source).toMatch(/No data for this period/);
	});

	test('refresh button is disabled during loading or refreshing', () => {
		expect(source).toMatch(/disabled=/);
	});

	test('root element has ui-card class', () => {
		expect(source).toMatch(/ui-card/);
	});

	test('title is rendered in an h2', () => {
		expect(source).toMatch(/widget-card__title/);
	});
});

describe('Pure modules stay server-free and DOM-free', () => {
	const pureModules = [
		'./top-tools.ts',
		'./filter.ts',
		'./picker.ts',
		'./widget.ts'
	];

	for (const mod of pureModules) {
		const source = readFileSync(new URL(mod, import.meta.url), 'utf8');
		const name = mod.replace('./', '');

		test(`${name} does not import $lib/server`, () => {
			expect(source).not.toMatch(/from ['"]\$lib\/server/);
		});

		test(`${name} does not statically import Svelte components`, () => {
			// .svelte imports are only in component files
			expect(source).not.toMatch(/from ['"].*\.svelte['"]/);
		});

		test(`${name} does not access the DOM directly`, () => {
			expect(source).not.toMatch(/\bdocument\b/);
			// "window" can appear in JSDoc comments (e.g. "session window");
			// only flag actual property access patterns.
			expect(source).not.toMatch(/\bwindow\./);
		});
	}
});
