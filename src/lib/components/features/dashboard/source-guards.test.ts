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

	describe('WidgetGrid source: grid rules + clamp breakpoints', () => {
		const source = readFileSync(
			new URL('./WidgetGrid.svelte', import.meta.url),
			'utf8'
		);

		test('has 4-column desktop grid', () => {
			expect(source).toMatch(/grid-template-columns:\s*repeat\(4/);
		});

		test('has row-dense auto-flow', () => {
			expect(source).toMatch(/grid-auto-flow:\s*row\s+dense/);
		});

		test('has 6rem auto-rows', () => {
			expect(source).toMatch(/grid-auto-rows:\s*6rem/);
		});

		test('emits data-w and data-h on grid items', () => {
			expect(source).toMatch(/data-w=/);
			expect(source).toMatch(/data-h=/);
		});

		test('clamps wide widgets at the 64rem breakpoint', () => {
			expect(source).toMatch(/max-width:\s*63\.99rem/);
			expect(source).toMatch(/data-w='3']/);
			expect(source).toMatch(/data-w='4']/);
		});

		test('full-widths every widget at the 40rem breakpoint', () => {
			expect(source).toMatch(/max-width:\s*39\.99rem/);
			expect(source).toMatch(/data-w\]/);
		});
	});

	describe('WidgetCard source: refresh spin + reduced-motion guard', () => {
		const source = readFileSync(
			new URL('./WidgetCard.svelte', import.meta.url),
			'utf8'
		);

		test('refresh button gets is-spinning class when refreshing or loading', () => {
			expect(source).toMatch(/class:is-spinning=\{refreshing \|\| status === 'loading'\}/);
		});

		test('spinner animation keyframe rotates 360deg', () => {
			expect(source).toMatch(/@keyframes\s+widget-refresh-spin/);
			expect(source).toMatch(/transform:\s*rotate\(360deg\)/);
		});

		test('spinner applies to the refresh icon svg', () => {
			expect(source).toMatch(/\.widget-card__refresh\.is-spinning/);
			expect(source).toMatch(/animation:\s*widget-refresh-spin/);
		});

		test('prefers-reduced-motion suppresses the spinner', () => {
			expect(source).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
			expect(source).toMatch(/animation:\s*none/);
		});
	});

	describe('WidgetsModal source: width select stringifies value', () => {
		const source = readFileSync(
			new URL('./WidgetsModal.svelte', import.meta.url),
			'utf8'
		);

		test('width <select> passes a string, not a raw number, to value', () => {
			// Svelte's select_option compares with is(option.__value, value).
			// Static option values like value="1" become option.__value = "1" (string),
			// so a numeric binding never matches and selectedIndex stays -1, making
			// the saved width appear lost even though it is persisted.  Wrapping
			// with String(...) keeps the two sides in the same type.
			expect(source).toMatch(/value=\{String\(placement\.width\)\}/);
		});

		test('width <select> options are the four quoted string literals "1".."4"', () => {
			expect(source).toMatch(/<option value="1">1 block<\/option>/);
			expect(source).toMatch(/<option value="2">2 blocks<\/option>/);
			expect(source).toMatch(/<option value="3">3 blocks<\/option>/);
			expect(source).toMatch(/<option value="4">4 blocks \(full\)<\/option>/);
		});

		test('would fail if a numeric value were restored (regression pin)', () => {
			// If someone reverts to value={placement.width} the String(…) guard
			// above fails; this test documents the invariant explicitly so the
			// failure mode is obvious on a diff.  Svelte strict `is()` compares
			// option.__value (string) against the binding (number) → no match.
			expect(source).not.toMatch(/value=\{placement\.width\}/);
		});
	});

	describe('FilterSelector source: selects use string-typed values', () => {
		const source = readFileSync(
			new URL('./FilterSelector.svelte', import.meta.url),
			'utf8'
		);

		test('period select value is a string (no numeric coercion)', () => {
			// filter.period is DashboardPeriod (string union); the comparison
			// with option.__value stays within string domain.
			expect(source).toMatch(/value=\{filter\.period\}/);
			expect(source).not.toMatch(/value=\{Number\(/);
			expect(source).not.toMatch(/value=\{\d+\}/);
		});

		test('scope select value falls back to string SCOPE_ALL', () => {
			// filter.scope ?? SCOPE_ALL is always a string (null coalesces to
			// the string literal 'all'), keeping the is() comparison happy.
			expect(source).toMatch(/value=\{filter\.scope \?\? SCOPE_ALL\}/);
			expect(source).not.toMatch(/value=\{filter\.scope\b(?! \?\?)/);
		});

		test('options bind from typed string option.value fields', () => {
			expect(source).toMatch(/value=\{option\.value\}/);
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
