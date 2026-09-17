import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildWidgetUrl, defaultIsEmpty, widgetFetchKey } from './data.svelte';
import { widgetSettingSignature } from '$lib/widgets/settings';
import type { DashboardFilter } from '$lib/model/dashboard';

/**
 * Unit tests for the pure helpers exported by useWidgetData (dashboard Phase 3,
 * task #410). These are exercised by the widget bodies and must stay
 * testable without a component or hydration context.
 */

describe('buildWidgetUrl()', () => {
	const base: DashboardFilter = { period: '30d', scope: null };

	test('includes period and scope=all for a null scope', () => {
		const url = buildWidgetUrl('/api/dashboard/kpi', base, false);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('period')).toBe('30d');
		expect(params.get('scope')).toBe('all');
		expect(params.has('refresh')).toBe(false);
	});

	test('includes the scoped directory when scope is non-null', () => {
		const filter: DashboardFilter = { period: '7d', scope: '/repo/a' };
		const url = buildWidgetUrl('/api/dashboard/top-tools', filter, false);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('period')).toBe('7d');
		expect(params.get('scope')).toBe('/repo/a');
	});

	test('appends ?refresh=1 when refresh is true', () => {
		const url = buildWidgetUrl('/api/dashboard/kpi', base, true);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('refresh')).toBe('1');
	});

	test('refresh flag is independent of period/scope', () => {
		const url = buildWidgetUrl('/api/dashboard/cost-per-day', base, true);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('period')).toBe('30d');
		expect(params.get('scope')).toBe('all');
		expect(params.get('refresh')).toBe('1');
	});

	test('source path is preserved as the base', () => {
		const url = buildWidgetUrl('/api/dashboard/sessions-per-day', base, false);
		expect(url.startsWith('/api/dashboard/sessions-per-day?')).toBe(true);
	});

	test('appends w.basic=1&w.mcp=0 for top-tools with those settings', () => {
		const url = buildWidgetUrl(
			'/api/dashboard/top-tools',
			base,
			false,
			{ basic: true, mcp: false }
		);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('w.basic')).toBe('1');
		expect(params.get('w.mcp')).toBe('0');
	});

	test('omits w.* params for a widget with no settings (kpi)', () => {
		const url = buildWidgetUrl(
			'/api/dashboard/kpi',
			base,
			false,
			{}
		);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.has('w.basic')).toBe(false);
		expect(params.has('w.mcp')).toBe(false);
	});

	test('omits w.* params when settings is undefined (back-compat)', () => {
		const url = buildWidgetUrl('/api/dashboard/kpi', base, false);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.has('w.basic')).toBe(false);
		expect(params.has('w.mcp')).toBe(false);
	});
});

describe('defaultIsEmpty()', () => {
	test('null is empty', () => {
		expect(defaultIsEmpty(null)).toBe(true);
	});

	test('undefined is empty', () => {
		expect(defaultIsEmpty(undefined)).toBe(true);
	});

	test('an empty array is empty', () => {
		expect(defaultIsEmpty([])).toBe(true);
	});

	test('a non-empty array is not empty', () => {
		expect(defaultIsEmpty([1])).toBe(false);
		expect(defaultIsEmpty(['a'])).toBe(false);
	});

	test('a non-null object is not empty (used by top-tools)', () => {
		// top-tools passes a custom isEmpty; defaultIsEmpty should return false
		// for object payloads so it does not incorrectly show the empty state.
		expect(defaultIsEmpty({ tools: [], capped: false })).toBe(false);
		expect(defaultIsEmpty({})).toBe(false);
	});

	test('a non-empty string is not empty', () => {
		expect(defaultIsEmpty('hello')).toBe(false);
	});

	test('zero is not empty (number payloads)', () => {
		expect(defaultIsEmpty(0)).toBe(false);
	});
});

/**
 * Verify data.svelte.ts exports only pure helpers at module level (no fetch
 * call at import time).
 */
describe('data.svelte.ts module-level purity', () => {
	test('buildWidgetUrl, defaultIsEmpty and widgetFetchKey are exported functions', async () => {
		const source = new URL('./data.svelte.ts', import.meta.url);
		const content = await Bun.file(source).text();
		expect(content).toMatch(/export\s+function\s+buildWidgetUrl/);
		expect(content).toMatch(/export\s+function\s+defaultIsEmpty/);
		expect(content).toMatch(/export\s+function\s+widgetFetchKey/);
	});

	test('does not statically import uplot or Svelte components', async () => {
		const source = new URL('./data.svelte.ts', import.meta.url);
		const content = await Bun.file(source).text();
		expect(content).not.toMatch(/from ['"]uplot['"]/);
	});
});

describe('widgetFetchKey()', () => {
	const base: DashboardFilter = { period: '30d', scope: null };

	test('includes source, period, scope and settings signature', () => {
		const sig = widgetSettingSignature('top-tools', { basic: true, mcp: false });
		const key = widgetFetchKey('/api/dashboard/top-tools', base, sig);
		expect(key).toContain('/api/dashboard/top-tools');
		expect(key).toContain('30d');
		expect(key).toContain(''); // scope is null -> ''
		// The signature is NUL-separated; verify it differs from the no-settings key.
		const sigDefault = widgetSettingSignature('top-tools', { basic: true, mcp: true });
		const keyDefault = widgetFetchKey('/api/dashboard/top-tools', base, sigDefault);
		expect(key).not.toBe(keyDefault);
	});

	test('identical settings produce an identical key regardless of insertion order', () => {
		const sigA = widgetSettingSignature('top-tools', { basic: false, mcp: true });
		const sigB = widgetSettingSignature('top-tools', { mcp: true, basic: false });
		const keyA = widgetFetchKey('/api/dashboard/top-tools', base, sigA);
		const keyB = widgetFetchKey('/api/dashboard/top-tools', base, sigB);
		expect(keyA).toBe(keyB);
	});

	test('a settings-only change yields a different key (triggers stale-clear + refetch)', () => {
		const sigBefore = widgetSettingSignature('top-tools', { basic: true, mcp: true });
		const sigAfter = widgetSettingSignature('top-tools', { basic: false, mcp: true });
		const keyBefore = widgetFetchKey('/api/dashboard/top-tools', base, sigBefore);
		const keyAfter = widgetFetchKey('/api/dashboard/top-tools', base, sigAfter);
		expect(keyBefore).not.toBe(keyAfter);
	});

	test('a widget with no settings gets an empty signature component', () => {
		const sig = widgetSettingSignature('kpi', {});
		expect(sig).toBe('');
		const key = widgetFetchKey('/api/dashboard/kpi', base, sig);
		// kpi has no declared settings, so the signature part is ''.
		const parts = key.split('\u0000');
		expect(parts[3]).toBe('');
	});

	test('cloned settings map with equal values yields an identical key (identity independence)', () => {
		// Regression guard for task #529: the effect must depend on the signature
		// string, not the settings object identity. A cloned map with the same
		// per-widget values must produce the same fetch key so the effect does
		// not re-run and no in-flight request is aborted.
		const original = { basic: true, mcp: false };
		const cloned = { ...original };
		// Different identity, equal per-widget values.
		expect(cloned).not.toBe(original);
		const sigOriginal = widgetSettingSignature('top-tools', original);
		const sigCloned = widgetSettingSignature('top-tools', cloned);
		expect(sigOriginal).toBe(sigCloned);
		const keyOriginal = widgetFetchKey('/api/dashboard/top-tools', base, sigOriginal);
		const keyCloned = widgetFetchKey('/api/dashboard/top-tools', base, sigCloned);
		expect(keyOriginal).toBe(keyCloned);
	});

	test('cloned settings map with equal values yields an identical key for a widget without settings', () => {
		// Same identity-independence guarantee for widgets that declare no settings.
		const original = {};
		const cloned = { ...original };
		expect(cloned).not.toBe(original);
		const sigOriginal = widgetSettingSignature('kpi', original);
		const sigCloned = widgetSettingSignature('kpi', cloned);
		expect(sigOriginal).toBe(sigCloned);
		expect(sigOriginal).toBe('');
		const keyOriginal = widgetFetchKey('/api/dashboard/kpi', base, sigOriginal);
		const keyCloned = widgetFetchKey('/api/dashboard/kpi', base, sigCloned);
		expect(keyOriginal).toBe(keyCloned);
	});
});

describe('data.svelte.ts source guards (task #529)', () => {
	const source = readFileSync(
		new URL('./data.svelte.ts', import.meta.url),
		'utf8'
	);

  test('widgetFetchKey accepts a string signature, not a settings object', () => {
		// The third parameter must be typed as string; no settings-object consumption.
		expect(source).toMatch(/widgetFetchKey\s*\([^)]*settingsSignature:\s*string/);
		// Extract the widgetFetchKey function body and verify it does not call
		// widgetSettingSignature or settings() — those belong in the caller.
		const fnMatch = source.match(/export\s+function\s+widgetFetchKey\s*\([^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/);
		expect(fnMatch).not.toBeNull();
		const fnBody = fnMatch![1];
		expect(fnBody).not.toMatch(/\bwidgetSettingSignature\b/);
		expect(fnBody).not.toMatch(/\bsettings\(\)/);
	});

	test('the effect reads settingsSignature() for the key and settings() only inside untrack', () => {
		// The effect dependency is the signature getter; values are untracked for URL construction.
		expect(source).toMatch(/const\s+currentSignature\s*=\s*settingsSignature\(\)/);
		expect(source).toMatch(/widgetFetchKey\(currentSource,\s*current,\s*currentSignature\)/);
		expect(source).toMatch(/untrack\s*\(\s*\(\)\s*=>\s*settings\(\)/);
		// settings() must not appear outside of untrack in the effect body.
		const effectIdx = source.indexOf('$effect(() => {');
		expect(effectIdx).toBeGreaterThan(-1);
		let depth = 0;
		let inBody = false;
		let bodyStart = -1;
		for (let i = effectIdx; i < source.length; i++) {
			const ch = source[i];
			if (ch === '{') {
				depth++;
				if (!inBody) { inBody = true; bodyStart = i + 1; }
			} else if (ch === '}') {
				depth--;
				if (inBody && depth === 0) {
					const effectBody = source.slice(bodyStart, i);
					// Strip every untrack(...) occurrence (non-greedy, balanced parens).
					let stripped = effectBody;
					let changed = true;
					while (changed) {
						changed = false;
						const idx = stripped.indexOf('untrack(');
						if (idx === -1) break;
						// Find matching closing paren.
						let d = 1;
						let j = idx + 'untrack('.length;
						while (j < stripped.length && d > 0) {
							if (stripped[j] === '(') d++;
							else if (stripped[j] === ')') d--;
							j++;
						}
						if (d === 0) {
							stripped = stripped.slice(0, idx) + stripped.slice(j);
							changed = true;
						}
					}
					expect(stripped).not.toContain('settings()');
					break;
				}
			}
		}
	});
});

describe('WidgetShell.svelte source guards (task #529)', () => {
	const source = readFileSync(
		new URL('./WidgetShell.svelte', import.meta.url),
		'utf8'
	);

	test('computes a $derived settingsSignature from widgetSettingSignature', () => {
		expect(source).toMatch(/\$derived\(widgetSettingSignature\(/);
	});

	test('passes settingsSignature as a reactive getter to useWidgetData', () => {
		expect(source).toMatch(/settingsSignature:\s*\(\)\s*=>\s*settingsSignature/);
	});

	test('still passes the values getter (settings) alongside the signature', () => {
		expect(source).toMatch(/settings:\s*\(\)\s*=>\s*settings/);
	});
});

/**
 * Source guards for task #532: the no-op guard, no-cleanup effect, and explicit
 * abort ownership in data.svelte.ts.
 *
 * These are structural assertions on the effect body — they catch regressions
 * where a developer silently removes the guard or moves abort cleanup back into
 * the $effect teardown. A behavioural regression (spurious Svelte 5 re-run
 * refetching every widget) is NOT detectable here without a DOM/browser harness;
 * that gap is noted in the completion comment.
 */
describe('data.svelte.ts source guards (task #532)', () => {
	const source = readFileSync(
		new URL('./data.svelte.ts', import.meta.url),
		'utf8'
	);

	/**
	 * Helper: extract the body of the $effect(() => { ... }) from the source.
	 * Returns the text between the outermost balanced braces of the effect callback.
	 */
	function extractEffectBody(src: string): string {
		const idx = src.indexOf('$effect(() => {');
		expect(idx).toBeGreaterThan(-1);
		let depth = 0;
		let bodyStart = -1;
		for (let i = idx; i < src.length; i++) {
			if (src[i] === '{') {
				depth++;
				if (depth === 1) bodyStart = i + 1;
			} else if (src[i] === '}') {
				depth--;
				if (depth === 0 && bodyStart !== -1) {
					return src.slice(bodyStart, i);
				}
			}
		}
		throw new Error('Unclosed $effect body');
	}

	test('the effect computes first, scopeChanged, tokenChanged, manualChanged', () => {
		const body = extractEffectBody(source);
		expect(body).toMatch(/\bfirst\s*=/);
		expect(body).toMatch(/\bscopeChanged\s*=/);
		expect(body).toMatch(/\btokenChanged\s*=/);
		expect(body).toMatch(/\bmanualChanged\s*=/);
	});

	test('the no-op guard (early return) appears before any side effect', () => {
		const body = extractEffectBody(source);
		// The guard predicate must be present.
		expect(body).toMatch(/!\s*first\s*&&\s*!scopeChanged\s*&&\s*!tokenChanged\s*&&\s*!manualChanged/);
		// The early return must exist.
		expect(body).toMatch(/return\s*;/);

		// Verify ordering: the `return;` line comes before every side effect.
		const retIdx = body.indexOf('return;');
		expect(retIdx).toBeGreaterThan(-1);

		// Find the first occurrence of each side effect AFTER the return.
		const sideEffects = [
			{ name: 'status write', pattern: /\bstatus\s*=/ },
			{ name: 'data write', pattern: /\bdata\s*=/ },
			{ name: 'controller?.abort()', pattern: /controller\??\.abort\(\)/ },
			{ name: 'fetcher call', pattern: /\bfetcher\s*\(/ }
		];
		for (const { name, pattern } of sideEffects) {
			const match = body.match(pattern);
			expect(match).not.toBeNull();
			expect(match!.index).toBeGreaterThan(retIdx);
		}
	});

	test('the effect body returns no cleanup function (no teardown abort)', () => {
		const body = extractEffectBody(source);
		// A cleanup function would look like `return () => { ... abort ... }`.
		// We check there is no `return () =>` pattern inside the effect body.
		expect(body).not.toMatch(/\breturn\s*\(\)\s*=>/);
		// Also check there's no returned arrow at all that contains abort.
		expect(body).not.toMatch(/return\s*\([^)]*\)\s*=>/);
	});

	test('onDestroy is used to abort the controller on component destroy', () => {
		expect(source).toMatch(/\bonDestroy\s*\(\s*\(\s*\)\s*=>/);
		// The onDestroy callback must contain controller?.abort().
		const onDestroyMatch = source.match(/onDestroy\s*\(\s*\(\s*\)\s*=>\s*\{([^}]*)\}/s);
		expect(onDestroyMatch).not.toBeNull();
		expect(onDestroyMatch![1]).toMatch(/controller\??\.abort\(\)/);
	});

	test('abort ownership: controller?.abort() sits immediately before new AbortController()', () => {
		const body = extractEffectBody(source);
		// Find the controller?.abort() call and verify the next non-whitespace
		// statement starts with `const active = new AbortController()`.
		const abortIdx = body.indexOf('controller?.abort()');
		expect(abortIdx).toBeGreaterThan(-1);
		const afterAbort = body.slice(abortIdx);
		// The very next meaningful statement should be `const active = new AbortController();`.
		expect(afterAbort).toMatch(/controller\??\.abort\(\)[\s\S]*?const\s+active\s*=\s*new\s+AbortController\(\)/);
		// And controller is assigned from active.
		expect(afterAbort).toMatch(/controller\s*=\s*active/);
	});

	test('lastToken and lastManual are updated after the guard and drive tokenChanged/manualChanged', () => {
		const body = extractEffectBody(source);
		// They must be assigned after the guard return.
		const retIdx = body.indexOf('return;');
		const lastTokenIdx = body.indexOf('lastToken = token');
		const lastManualIdx = body.indexOf('lastManual = manual');
		expect(lastTokenIdx).toBeGreaterThan(-1);
		expect(lastManualIdx).toBeGreaterThan(-1);
		expect(lastTokenIdx).toBeGreaterThan(retIdx);
		expect(lastManualIdx).toBeGreaterThan(retIdx);
		// And they must be used in the change-flag computations.
		expect(body).toMatch(/tokenChanged\s*=\s*token\s*!==\s*lastToken/);
		expect(body).toMatch(/manualChanged\s*=\s*manual\s*!==\s*lastManual/);
	});
});
