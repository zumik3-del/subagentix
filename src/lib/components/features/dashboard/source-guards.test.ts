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

describe('DayTable source: fit wiring + no chart import', () => {
	const source = readFileSync(
		new URL('./DayTable.svelte', import.meta.url),
		'utf8'
	);

	test('does not import any chart library', () => {
		expect(source).not.toMatch(/from ['"]uplot['"]/);
		expect(source).not.toMatch(/from ['"]d3['"]/);
		expect(source).not.toMatch(/from ['"]chart['"]/);
	});

	test('imports useRowFit for client-side whole-row trimming', () => {
		expect(source).toMatch(/from ['"]\.\/fit\.svelte['"]/);
		expect(source).toMatch(/\buseRowFit\b/);
	});

	test('reverses the ascending points array so the newest day is first', () => {
		// [...points].reverse() is the explicit newest-first ordering required
		// by task #453; a naive ascending render would show the oldest day on top.
		expect(source).toMatch(/\[\.\.\.points\]\.reverse\(\)/);
	});

	test('slices visible rows to fit.budget (whole-row trim)', () => {
		// The fit contract: rows.slice(0, fit.budget) trims to whole rows after
		// mount; SSR renders every row because fit.budget equals total until measured.
		expect(source).toMatch(/rows\.slice\(0,\s*fit\.budget\)/);
	});

	test('renders sr-only caption with the label', () => {
		expect(source).toMatch(/<caption class="sr-only">/);
		expect(source).toMatch(/\{label\}/);
	});

	test('renders sr-only thead with Day and value column headers', () => {
		expect(source).toMatch(/<th scope="col">Day<\/th>/);
		expect(source).toMatch(/<th scope="col">\{label\}<\/th>/);
	});

	test('renders each day as a scope="row" header cell', () => {
		expect(source).toMatch(/<th scope="row"/);
		expect(source).toMatch(/class="day-table__day"/);
	});

	test('formats the value cell with the supplied formatter', () => {
		expect(source).toMatch(/formatValue\(row\.value\)/);
	});

	test('renders the empty state when points are absent', () => {
		expect(source).toMatch(/day-table__empty/);
	});

	test('wraps the table in a figure with overflow:hidden fit host', () => {
		expect(source).toMatch(/<figure class="day-table"/);
		expect(source).toMatch(/bind:this=\{list\}/);
		expect(source).toMatch(/overflow:\s*hidden/);
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

	test('does not hardcode a default limit of 8 (fit is driven by useRowFit)', () => {
		// Task #444 replaced the old `limit = 8` default with `limit = Number.POSITIVE_INFINITY`
		// and uses `useRowFit` to trim to whole rows after mount. A hardcoded default of 8
		// would silently ignore the per-widget minHeight contract.
		expect(source).not.toMatch(/\blimit\s*=\s*8\b/);
		expect(source).toMatch(/\blimit\s*=\s*Number\.POSITIVE_INFINITY\b/);
	});

	test('imports useRowFit for client-side whole-row trimming', () => {
		expect(source).toMatch(/from ['"]\.\/fit\.svelte['"]/);
		expect(source).toMatch(/\buseRowFit\b/);
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

		test('emits desktop columns via var(--grid-columns) with --grid-columns:4 inline', () => {
			// Epic #462 stage 2 replaced the literal `repeat(4, …)` with a custom
			// property so layout.ts geometry is the single source of truth.  The
			// template literal still pins the value to 4 at the source level.
			expect(source).toMatch(/grid-template-columns:\s*repeat\(var\(--grid-columns\)/);
			expect(source).toMatch(/\-\-grid-columns:\$\{GRID_COLUMNS\}/);
		});

		test('emits row height via var(--grid-row-height) with --grid-row-height:6rem inline', () => {
			// Same source-of-truth principle: `grid-auto-rows` reads the custom prop.
			expect(source).toMatch(/grid-auto-rows:\s*var\(--grid-row-height\)/);
			expect(source).toMatch(/\-\-grid-row-height:\$\{GRID_ROW_HEIGHT_REM\}rem/);
		});

		test('preserves row-dense auto-flow', () => {
			expect(source).toMatch(/grid-auto-flow:\s*row\s+dense/);
		});

		test('emits grid-stack-item class on each li', () => {
			// The enhancement seam: every item carries the gridstack contract class
			// so the future client-side upgrade can adopt the DOM without a rewrite.
			expect(source).toMatch(/class="widget-grid__item grid-stack-item"/);
		});

		test('emits gs-x/gs-y/gs-w/gs-h placement attributes on each li', () => {
			expect(source).toMatch(/'gs-x': placement\.x/);
			expect(source).toMatch(/'gs-y': placement\.y/);
			expect(source).toMatch(/'gs-w': placement\.width/);
			expect(source).toMatch(/'gs-h': placement\.height/);
		});

		test('emits --gs-* custom properties on each li inline style', () => {
			expect(source).toMatch(/\-\-gs-x:/);
			expect(source).toMatch(/\-\-gs-y:/);
			expect(source).toMatch(/\-\-gs-w:/);
			expect(source).toMatch(/\-\-gs-h:/);
		});

		test('wraps WidgetHost in a grid-stack-item-content div', () => {
			// The fit-measurement chain depends on this wrapper:
			// li → .grid-stack-item-content → .widget-host → .widget-card (all height:100%).
			// The chain itself is CSS reasoning only here — no ResizeObserver is runnable
			// in the test environment; the structural presence is what this asserts.
			expect(source).toMatch(/class="grid-stack-item-content"/);
			// The wrapper must sit between <li> and <WidgetHost>, not above or below.
			const match = source.match(
				/<li[\s\S]*?class="grid-stack-item-content"[\s\S]*?<WidgetHost/
			);
			expect(match).not.toBeNull();
		});

		test('container never carries the grid-stack class', () => {
			// Progressive-enhancement guarantee: the <ul> is purely .widget-grid in SSR.
			// grid-stack is added only on the client after the enhancement chunk loads.
			expect(source).not.toMatch(/<ul[^>]*\bgrid-stack\b/);
		});

		test('gridstack library is never statically or type-only imported — wrapper owns the dynamic import', () => {
			// Stage-2 invariant ("enhancement arrives next stage") is superseded by stage 3.
			// WidgetGrid.svelte must not pull gridstack into the SSR bundle; the only
			// allowed reference to the library is the local wrapper which dynamic-imports
			// it at enhancement time. A static or type-only `from 'gridstack'` would
			// defeat tree-shaking and break SSR.
			expect(source).not.toMatch(/from ['"]gridstack['"]/);
			expect(source).not.toMatch(/import\s+type\s+.*from\s+['"]gridstack['"]/);
			// Importing the local wrapper is expected and required.
			expect(source).toMatch(/from ['"]\.\/gridstack['"]/);
		});

		test('emits data-w but not data-h as a CSS consumption hook on grid items', () => {
			// data-w drives the narrow-mode grid-column clamp rules (≤63.99rem / ≤39.99rem).
			// data-h is emitted as metadata but is NOT consumed by CSS: row height uses
			// `grid-row: span var(--gs-h)` instead, making a 16-entry lookup table redundant.
			expect(source).toMatch(/data-w=/);
			expect(source).toMatch(/data-h=/);
		});

		test('clamps wide widgets at the 64rem breakpoint', () => {
			expect(source).toMatch(/max-width:\s*63\.99rem/);
			expect(source).toMatch(/data-w='3']/);
			expect(source).toMatch(/data-w='4']/);
			expect(source).toMatch(/data-w='5']/);
			expect(source).toMatch(/data-w='6']/);
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

	describe('WidgetCard source: body overflow clip', () => {
		const source = readFileSync(
			new URL('./WidgetCard.svelte', import.meta.url),
			'utf8'
		);

		test('widget-card root has overflow: hidden to clip the body contour', () => {
			// The hard overflow clip on the card root is the guarantee that no body
			// can paint past the rounded contour, even mid-measurement (task #444).
			expect(source).toMatch(/\.widget-card[^{]*\{[^}]*overflow:\s*hidden/);
		});

		test('widget-card__body has overflow: hidden as a secondary clip', () => {
			expect(source).toMatch(/\.widget-card__body[^{]*\{[^}]*overflow:\s*hidden/);
		});
	});

	describe('WidgetSettings source: width select stringifies value', () => {
		const source = readFileSync(
			new URL('./WidgetSettings.svelte', import.meta.url),
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

		test('width <select> options are derived from WIDGET_MAX_WIDTH (1..6), not hardcoded literals', () => {
			// Task #471 replaced the four static `<option value="1">.."4">` literals with
			// `Array.from({ length: WIDGET_MAX_WIDTH }, ...)`, deriving options from the
			// shared bound so the select never disagrees with the grid column count.
			expect(source).toMatch(/WIDGET_MAX_WIDTH/);
			expect(source).toMatch(/Array\.from\(\{ length: WIDGET_MAX_WIDTH \}/);
		});

		test('would fail if a numeric value were restored (regression pin)', () => {
			// If someone reverts to value={placement.width} the String(…) guard
			// above fails; this test documents the invariant explicitly so the
			// failure mode is obvious on a diff.  Svelte strict `is()` compares
			// option.__value (string) against the binding (number) → no match.
			expect(source).not.toMatch(/value=\{placement\.width\}/);
		});
	});

	describe('WidgetsModal source: no width select (size moved to WidgetSettings)', () => {
		const source = readFileSync(
			new URL('./WidgetsModal.svelte', import.meta.url),
			'utf8'
		);

		test('no longer owns a width <select>', () => {
			// Task #449 moved the Width/Height controls out into the per-widget
			// gear-opened WidgetSettings dialog. The picker modal now only lists
			// widgets with visibility toggles and a Restore defaults action.
			expect(source).not.toMatch(/value=\{String\(placement\.width\)\}/);
			expect(source).not.toMatch(/<option value="1">1 block<\/option>/);
			expect(source).not.toMatch(/<option value="4">4 blocks \(full\)<\/option>/);
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

describe('gridstack.ts source: dynamic-import-only contract', () => {
	const source = readFileSync(
		new URL('./gridstack.ts', import.meta.url),
		'utf8'
	);

	test('dynamic-imports the gridstack library', () => {
		// The wrapper must never statically load gridstack; it is loaded on
		// demand when the desktop breakpoint is matched.
		expect(source).toMatch(/import\s*\(\s*['"]gridstack['"]\s*\)/);
	});

	test('dynamic-imports the gridstack stylesheet in the same Promise.all', () => {
		expect(source).toMatch(/import\s*\(\s*['"]gridstack\/dist\/gridstack\.min\.css['"]\s*\)/);
	});

	test('does not statically import from the gridstack library', () => {
		// A bare `from 'gridstack'` (non-type) would pull the library into the SSR bundle.
		// A type-only import (`import type { ... } from 'gridstack'`) is erased at compile
		// time and does not affect the bundle; it is tolerated here as a TypeScript aid.
		expect(source).not.toMatch(/import\s+(?!\s*type\b)[^;\n]*from\s+['"]gridstack['"]/);
	});

	test('desktop breakpoint gate reads layout.ts constant, not a hardcoded literal', () => {
		// The DESKTOP_QUERY must be constructed from GRID_DESKTOP_MIN_WIDTH_REM
		// so both the CSS fallback and the JS gate share one source of truth.
		expect(source).toMatch(/GRID_DESKTOP_MIN_WIDTH_REM/);
		expect(source).not.toMatch(/\(min-width:\s*64\s*rem\)/);
	});

	test('adds the grid-stack class to the container at enhancement time', () => {
		// The class signals that the fallback CSS rules (scoped to :not(.grid-stack))
		// should stop applying; gridstack takes over positioning.
		expect(source).toMatch(/classList\.add\(['"]grid-stack['"]\)/);
	});

	test('removes the grid-stack class on teardown', () => {
		// Crossing back below the breakpoint or unmounting must restore the
		// fallback CSS by removing the class the enhancement added.
		expect(source).toMatch(/classList\.remove\(['"]grid-stack['"]/);
	});

	test('failure path is wrapped in try/catch and calls teardown', () => {
		// Any import or init failure must leave the grid in its static fallback
		// state; unhandled rejections are not acceptable.
		expect(source).toMatch(/try\s*\{/);
		expect(source).toMatch(/catch\s*\{/);
		// The catch must reach teardown (not rethrow).
		const catchBody = source.match(/catch\s*\{([^}]*)\}/s);
		expect(catchBody).not.toBeNull();
		expect(catchBody![1]).toMatch(/#teardown/);
	});

	test('onActiveChange(false) is called on teardown', () => {
		// Teardown must tell the component to unfreeze so the reactive path
		// resumes and the grid re-renders from the static CSS fallback.
		expect(source).toMatch(/onActiveChange\(false\)/);
	});

	test('persistence calls onLayoutChange with the full placement list', () => {
		// After a settled gesture, the whole layout (including x/y) is read
		// back via #readLayout and forwarded — not just ids/sizes.
		expect(source).toMatch(/onLayoutChange\(this\.#readLayout\(\)\)/);
	});

	test('override layout.ts constants are used for grid config, not fresh literals', () => {
		// The init config must consume the shared geometry constants.
		expect(source).toMatch(/GRID_COLUMNS/);
		expect(source).toMatch(/GRID_ROW_HEIGHT_REM/);
		expect(source).toMatch(/GRID_GAP_HALF_REM/);
	});
});

describe('gridstack.ts snap-back fix: #readLayout reads live engine nodes', () => {
	const source = readFileSync(
		new URL('./gridstack.ts', import.meta.url),
		'utf8'
	);

	test('#readLayout iterates grid.engine.nodes, not grid.save(false)', () => {
		// The snap-back bug (task #471 follow-up) was caused by #readLayout calling
		// grid.save(false), which runs Utils.removeInternalForSave — that helper
		// strips `w` when w===1||w===minW and `h` when h===1||h===minH, so the
		// old code fell back to the stale model size and persisted the previous
		// value, which sync pushed back into the live node → snap-back.
		// The fix reads grid.engine.nodes directly (prepareNode guarantees numeric
		// in-bounds x/y/w/h) and only reports placements for model-known ids.
		expect(source).toMatch(/grid\.engine\.nodes/);
		// The old fall-through path (grid.save(false) → stale model fallback) must
		// not appear as a code path in #readLayout. The comment explicitly calls out
		// "deliberately **not** grid.save(false)" to prevent regression.
		expect(source).toMatch(/deliberately \*\*not\*\* \`grid\.save\(false\)\`/);
	});

	test('#readLayout falls back to WIDGET_MIN_WIDTH/HIGH via ??, not a stale placement', () => {
		// The ?? floors are there to satisfy TypeScript's optional typing on the
		// node fields; they can never resurrect a stale size because prepareNode
		// in gridstack always writes numeric x/y/w/h before a node enters engine.nodes.
		// A regression that re-introduces a stale-model fallback would lose the ??
		// or add a second lookup — this assertion pins the ??-only pattern.
		expect(source).toMatch(/node\.w \?\? WIDGET_MIN_WIDTH/);
		expect(source).toMatch(/node\.h \?\? WIDGET_MIN_HEIGHT/);
	});
});

describe('16px gutter invariant: three-way agreement + rem base', () => {
	const gridstackSource = readFileSync(
		new URL('./gridstack.ts', import.meta.url),
		'utf8'
	);
	const widgetGridSource = readFileSync(
		new URL('./WidgetGrid.svelte', import.meta.url),
		'utf8'
	);
	const appCssSource = readFileSync(
		new URL('../../../../app.css', import.meta.url),
		'utf8'
	);

	test('gridstack init margin uses GRID_GAP_HALF_REM, not GRID_GAP_REM', () => {
		// gridstack insets .grid-stack-item-content by margin inside each cell,
		// so a full-gap margin doubles the card-to-card gutter. The init config
		// must pass GRID_GAP_HALF_REM (not GRID_GAP_REM) as the margin value.
		// A revert to GRID_GAP_REM in the margin literal fails this.
		expect(gridstackSource).toMatch(/margin:\s*`\$\{GRID_GAP_HALF_REM\}rem`/);
		// This negative guard catches a revert even if the old value survives in a
		// comment — only the actual margin assignment matters.
		expect(gridstackSource).not.toMatch(/margin:\s*`\$\{GRID_GAP_REM\}rem`/);
	});

	test('--grid-gap-half is emitted in the SSR inline var string', () => {
		// The <ul> style attribute must carry --grid-gap-half so the .grid-stack
		// compensation rule can read it via var(--grid-gap-half). If this drops
		// out, the negative margin becomes 0 and the outer cards collapse inward.
		// A revert that removes --grid-gap-half from gridVars fails this.
		expect(widgetGridSource).toMatch(/\-\-grid-gap-half:\$\{GRID_GAP_HALF_REM\}rem/);
	});

	test('container pull-out applies only under .grid-stack and uses the same half', () => {
		// The negative margin that pulls the container out by one half-gap must
		// be scoped to .widget-grid.grid-stack so it does not affect the fallback
		// path. The compensation uses the same half as gridstack's margin.
		// A revert that moves the rule out of .grid-stack scope or changes the
		// variable fails this positive guard; a revert that adds the same rule
		// under :not(.grid-stack) fails the negative guard below.
		expect(widgetGridSource).toMatch(
			/\.widget-grid\.grid-stack\s*\{[\s\S]*?margin:\s*calc\(-1 \* var\(--grid-gap-half\)\)/
		);
		// The compensation must not leak into any :not(.grid-stack) block.
		const notBlocks: string[] = [];
		let i = 0;
		while (i < widgetGridSource.length) {
			const idx = widgetGridSource.indexOf(':not(.grid-stack)', i);
			if (idx === -1) break;
			const braceIdx = widgetGridSource.indexOf('{', idx);
			if (braceIdx === -1) { i = idx + 1; continue; }
			let depth = 0;
			let end = -1;
			for (let j = braceIdx; j < widgetGridSource.length; j++) {
				if (widgetGridSource[j] === '{') depth++;
				else if (widgetGridSource[j] === '}') {
					depth--;
					if (depth === 0) { end = j; break; }
				}
			}
			if (end === -1) { i = idx + 1; continue; }
			notBlocks.push(widgetGridSource.slice(braceIdx, end + 1));
			i = end + 1;
		}
		for (const block of notBlocks) {
			expect(block).not.toMatch(/margin:\s*calc/);
		}
	});

	test('fallback still sizes from gap: var(--grid-gap)', () => {
		// The non-enhanced path must keep the original gap value so the two modes
		// agree on card-to-card and page-edge spacing. A revert that changes this
		// to gap-half or a literal fails this.
		const notBlocks: string[] = [];
		let i = 0;
		while (i < widgetGridSource.length) {
			const idx = widgetGridSource.indexOf(':not(.grid-stack)', i);
			if (idx === -1) break;
			const braceIdx = widgetGridSource.indexOf('{', idx);
			if (braceIdx === -1) { i = idx + 1; continue; }
			let depth = 0;
			let end = -1;
			for (let j = braceIdx; j < widgetGridSource.length; j++) {
				if (widgetGridSource[j] === '{') depth++;
				else if (widgetGridSource[j] === '}') {
					depth--;
					if (depth === 0) { end = j; break; }
				}
			}
			if (end === -1) { i = idx + 1; continue; }
			notBlocks.push(widgetGridSource.slice(braceIdx, end + 1));
			i = end + 1;
		}
		const gridBlock = notBlocks.find((b) => b.includes('gap:'));
		expect(gridBlock).toBeDefined();
		expect(gridBlock).toMatch(/gap:\s*var\(--grid-gap\)/);
	});

	test('src/app.css declares no font-size on html or :root', () => {
		// The 16px rem base is the browser default, guaranteed by the absence of
		// any html/:root font-size rule. A future developer adding one would
		// silently rescale every rem in the app (rows, gaps, breakpoints). The
		// numeric canary (ROOT_FONT_SIZE_PX = 16) cannot detect a CSS addition;
		// only a source scan of app.css can. This guard catches that regression.
		expect(appCssSource).not.toMatch(/^\s*html\s*\{/m);
		const rootIdx = appCssSource.indexOf(':root {');
		expect(rootIdx).toBeGreaterThan(-1);
		let depth = 0;
		let end = -1;
		for (let i = rootIdx; i < appCssSource.length; i++) {
			if (appCssSource[i] === '{') depth++;
			else if (appCssSource[i] === '}') {
				depth--;
				if (depth === 0) { end = i; break; }
			}
		}
		expect(end).toBeGreaterThan(-1);
		const rootBlock = appCssSource.slice(rootIdx, end + 1);
		expect(rootBlock).not.toMatch(/font-size:/);
	});
});

describe('WidgetGrid list-style regression guard', () => {
	const source = readFileSync(
		new URL('./WidgetGrid.svelte', import.meta.url),
		'utf8'
	);

	test('list-style:none is unconditional, not scoped to :not(.grid-stack)', () => {
		// Bug found in task #471: list-style:none lived inside
		// `.widget-grid:not(.grid-stack)`. Once the gridstack enhancement adds the
		// `grid-stack` class to the <ul>, that rule stops matching, so every <li>
		// fell back to display:list-item and painted its default disc marker at the
		// top-left of the card (the "stray white circle"). Moving the declaration to
		// an unconditional `.widget-grid` rule eliminates the mode-dependency.
		// This test would fail if the rule were ever scoped back under :not(.grid-stack).
		expect(source).toMatch(/\.widget-grid\s*\{[^}]*list-style:\s*none/);
		// No :not(.grid-stack) block should contain list-style:none. The negative
		// lookahead via split+join is safer than a single regex across multiline CSS.
		const notBlock = source.match(/:not\(\.grid-stack\)\s*\{[^}]*\}/g) ?? [];
		for (const block of notBlock) {
			expect(block).not.toMatch(/list-style:\s*none/);
		}
	});
});
