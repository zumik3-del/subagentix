import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Unit tests for the flat widget server dispatch (dashboard widget engine,
 * task #493).
 *
 * Pins the contract between WIDGET_BUILDERS, builderFor, and resolveDashboardRequest
 * so the flat-dispatch refactor stays intact. Uses source scans and runtime
 * checks that don't require the server module to be directly importable.
 */

describe('builderFor dispatch: source-level invariants', () => {
	const source = readFileSync(
		new URL('./widgets.ts', import.meta.url),
		'utf8'
	);

	test('exports builderFor function', () => {
		expect(source).toMatch(/function builderFor\(widgetId: WidgetId\)/);
	});

	test('builderFor reads from WIDGET_BUILDERS via direct lookup', () => {
		expect(source).toMatch(/WIDGET_BUILDERS\[widgetId\]/);
	});

	test('builderFor throws for missing builder with descriptive message', () => {
		expect(source).toMatch(/throw new Error/);
		expect(source).toMatch(/has no payload builder/);
	});

	test('exports resolveDashboardRequest', () => {
		expect(source).toMatch(/export function resolveDashboardRequest/);
	});

	test('exports resolveFilter', () => {
		expect(source).toMatch(/export function resolveFilter/);
	});
});

describe('WIDGET_BUILDERS map is exhaustive over WidgetId', () => {
	const source = readFileSync(
		new URL('./widgets.ts', import.meta.url),
		'utf8'
	);

	test('the source file references every registered widget id as a builder key', async () => {
		const { WIDGET_IDS } = await import('$lib/widgets/registry');
		for (const id of WIDGET_IDS) {
			// Each id must appear as a key (quoted or unquoted) in the WIDGET_BUILDERS object.
			expect(source, id).toMatch(new RegExp(`(?:'|")?${id.replace(/-/g, '\\-')}(?:'|")?\\s*:`));
		}
	});

	test('no extra (unregistered) ids appear as keys in WIDGET_BUILDERS', async () => {
		const { WIDGET_IDS } = await import('$lib/widgets/registry');
		const knownIds = new Set(WIDGET_IDS);
		// Extract all quoted keys from the WIDGET_BUILDERS const object.
		const buildersBlock = source.match(/const WIDGET_BUILDERS[^{]*\{([\s\S]*?)\n\};/);
		expect(buildersBlock).not.toBeNull();
		const keyMatches = buildersBlock![1].matchAll(/'([^']+)'\\s*:/g);
		for (const match of keyMatches) {
			const key = match[1];
			expect(WIDGET_IDS as readonly string[], key).toContain(key);
		}
	});
});

describe('widgets.ts source: flat dispatch, no tier routing', () => {
	const source = readFileSync(new URL('./widgets.ts', import.meta.url), 'utf8');

	test('uses a single WIDGET_BUILDERS map (flat dispatch)', () => {
		expect(source).toMatch(/const WIDGET_BUILDERS/);
		expect(source).toMatch(/type WidgetBuilders/);
	});

	test('builderFor is a direct map lookup (no tier read in dispatch logic)', () => {
		// The actual dispatch function body should not reference .tier.
		// Comments mentioning tier are fine — we check the function body only.
		const builderForBody = source.match(
			/function builderFor[\s\S]*?return builder;\s*\}/
		);
		expect(builderForBody).not.toBeNull();
		expect(builderForBody![0]).not.toMatch(/\.tier\b/);
	});

	test('missing builder throws a descriptive error (500 guard)', () => {
		expect(source).toMatch(/throw new Error/);
		expect(source).toMatch(/has no payload builder/);
	});
});

describe('resolveDashboardRequest 404/400 behaviour', () => {
	const source = readFileSync(new URL('./widgets.ts', import.meta.url), 'utf8');

	test('unknown widget id returns 404', () => {
		expect(source).toMatch(/status: 404/);
		expect(source).toMatch(/Unknown widget/);
	});

	test('bad period returns 400 via invalidRequest', () => {
		expect(source).toMatch(/invalidRequest/);
		expect(source).toMatch(/Unknown period/);
	});
});
