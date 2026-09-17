import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_PERIOD,
	DEFAULT_FILTER,
	SCOPE_ALL,
	PERIOD_OPTIONS,
	ALL_SCOPE_OPTION,
	directoryOptions,
	parseFilter,
	filterSearch
} from './filter';
import type { DashboardFilter, DashboardPeriod } from '$lib/model/dashboard';
import type { DirectorySummary } from '$lib/model/types';

/**
 * Unit tests for the pure dashboard filter parse/serialise logic
 * (dashboard Phase 5, task #415; persisted preference task #457).
 *
 * Kept in a plain `.ts` module so URL parsing and option-building are
 * testable without a renderer or a DOM.
 */

describe('DEFAULT_PERIOD', () => {
	test('is the 7d preset', () => {
		expect(DEFAULT_PERIOD).toBe('7d');
	});
});

describe('DEFAULT_FILTER', () => {
	test('is { period: "7d", scope: null }', () => {
		expect(DEFAULT_FILTER).toEqual({ period: '7d', scope: null });
	});
});

describe('SCOPE_ALL', () => {
	test('is the string "all"', () => {
		expect(SCOPE_ALL).toBe('all');
	});
});

describe('PERIOD_OPTIONS', () => {
	test('has six options in selector order: today | 3d | 7d | 30d | 90d | all', () => {
		expect(PERIOD_OPTIONS.map((o) => o.value)).toEqual([
			'today',
			'3d',
			'7d',
			'30d',
			'90d',
			'all'
		]);
	});

	test('every option has an English label', () => {
		for (const opt of PERIOD_OPTIONS) {
			expect(opt.label.length, opt.value).toBeGreaterThan(0);
		}
	});

	test('labels match the spec vocabulary including new presets', () => {
		const labels = PERIOD_OPTIONS.map((o) => o.label);
		expect(labels).toContain('Today');
		expect(labels).toContain('Last 3 days');
		expect(labels).toContain('Last 7 days');
		expect(labels).toContain('Last 30 days');
		expect(labels).toContain('Last 90 days');
		expect(labels).toContain('All time');
	});
});

describe('ALL_SCOPE_OPTION', () => {
	test('has value all and label All projects', () => {
		expect(ALL_SCOPE_OPTION.value).toBe('all');
		expect(ALL_SCOPE_OPTION.label).toBe('All projects');
	});
});

	describe('directoryOptions()', () => {
		test('maps each directory to its project name when linked', () => {
			const dirs: DirectorySummary[] = [
				{ directory: '/a', projectName: 'Project A', sessionCount: 10, updatedAt: 0 },
				{ directory: '/b', projectName: 'Project B', sessionCount: 5, updatedAt: 0 }
			];
			const opts = directoryOptions(dirs);
			expect(opts).toHaveLength(2);
			expect(opts[0]).toEqual({ value: '/a', label: 'Project A' });
			expect(opts[1]).toEqual({ value: '/b', label: 'Project B' });
		});

		test('falls back to the raw directory path when projectName is null', () => {
			const dirs: DirectorySummary[] = [{ directory: '/repo/x', projectName: null, sessionCount: 0, updatedAt: 0 }];
			const opts = directoryOptions(dirs);
			expect(opts).toHaveLength(1);
			expect(opts[0]).toEqual({ value: '/repo/x', label: '/repo/x' });
		});

		test('empty input yields no options', () => {
			expect(directoryOptions([])).toEqual([]);
		});

		test('does not include the All projects sentinel', () => {
			const dirs: DirectorySummary[] = [{ directory: '/a', projectName: 'A', sessionCount: 0, updatedAt: 0 }];
			const opts = directoryOptions(dirs);
			expect(opts.find((o) => o.value === 'all')).toBeUndefined();
		});
	});

describe('parseFilter()', () => {
 	test('valid period and scope are passed through', () => {
 		const search = new URLSearchParams('period=7d&scope=/a');
 		expect(parseFilter(search, ['/a', '/b'])).toEqual({ period: '7d', scope: '/a' });
 	});

 	test('today and 3d periods are accepted through the URL', () => {
 		const today = parseFilter(new URLSearchParams('period=today'), []);
 		const threeD = parseFilter(new URLSearchParams('period=3d'), []);
 		expect(today).toEqual({ period: 'today', scope: null });
 		expect(threeD).toEqual({ period: '3d', scope: null });
 	});

 	test('blank period falls back to DEFAULT_PERIOD', () => {
 		const search = new URLSearchParams('scope=/a');
 		expect(parseFilter(search, ['/a'])).toEqual({ period: DEFAULT_PERIOD, scope: '/a' });
 	});

 	test('unknown period falls back to DEFAULT_PERIOD', () => {
 		const search = new URLSearchParams('period=invalid');
 		expect(parseFilter(search, [])).toEqual({ period: DEFAULT_PERIOD, scope: null });
 	});

 	test('blank scope becomes null (every directory)', () => {
 		const search = new URLSearchParams('period=30d&scope=');
 		expect(parseFilter(search, ['/a'])).toEqual({ period: '30d', scope: null });
 	});

 	test('scope=all becomes null (every directory)', () => {
 		const search = new URLSearchParams('period=30d&scope=all');
 		expect(parseFilter(search, ['/a'])).toEqual({ period: '30d', scope: null });
 	});

 	test('unknown scope falls back to null', () => {
 		const search = new URLSearchParams('period=30d&scope=/ghost');
 		expect(parseFilter(search, ['/a'])).toEqual({ period: '30d', scope: null });
 	});

 	test('no query params yields the default filter', () => {
 		expect(parseFilter(new URLSearchParams(), ['/a'])).toEqual({
 			period: DEFAULT_PERIOD,
 			scope: null
 		});
 	});

 	test('never throws on malformed input', () => {
 		expect(() => parseFilter(new URLSearchParams('period='), ['/a'])).not.toThrow();
 		expect(() => parseFilter(new URLSearchParams('scope='), ['/a'])).not.toThrow();
 	});

 	// --- Precedence table: URL > stored > default --------------------------------

 	test('valid URL period wins over stored period', () => {
 		const stored: DashboardFilter = { period: '90d', scope: null };
 		const search = new URLSearchParams('period=3d');
 		expect(parseFilter(search, [], stored)).toEqual({ period: '3d', scope: null });
 	});

 	test('valid URL scope wins over stored scope', () => {
 		const stored: DashboardFilter = { period: '7d', scope: '/stored' };
 		const search = new URLSearchParams('period=7d&scope=/url');
 		expect(parseFilter(search, ['/stored', '/url'], stored)).toEqual({ period: '7d', scope: '/url' });
 	});

 	test('blank period falls back to stored period when it is valid', () => {
 		const stored: DashboardFilter = { period: '30d', scope: null };
 		const search = new URLSearchParams('scope=/a');
 		expect(parseFilter(search, ['/a'], stored)).toEqual({ period: '30d', scope: '/a' });
 	});

 	test('blank period falls back to DEFAULT_PERIOD when stored period is missing', () => {
 		const stored: DashboardFilter = { period: '7d', scope: null };
 		// A deliberately corrupted stored value whose period is not a known preset.
 		const badStored = { period: 'forever', scope: null } as unknown as DashboardFilter;
 		const search = new URLSearchParams('');
 		expect(parseFilter(search, [], badStored)).toEqual({ period: DEFAULT_PERIOD, scope: null });
 	});

 	test('unknown URL period falls back to stored period then DEFAULT_PERIOD', () => {
 		const goodStored: DashboardFilter = { period: '90d', scope: null };
 		const badStored = { period: 'broken', scope: null } as unknown as DashboardFilter;

 		const search = new URLSearchParams('period=xxx');
 		expect(parseFilter(search, [], goodStored)).toEqual({ period: '90d', scope: null });
 		expect(parseFilter(search, [], badStored)).toEqual({ period: DEFAULT_PERIOD, scope: null });
 		expect(parseFilter(search, [])).toEqual({ period: DEFAULT_PERIOD, scope: null });
 	});

 	test('present valid URL scope wins over stored scope, even when stored is non-null', () => {
 		const stored: DashboardFilter = { period: '7d', scope: '/stored-dir' };
 		const search = new URLSearchParams('period=7d&scope=/url-dir');
 		expect(parseFilter(search, ['/stored-dir', '/url-dir'], stored)).toEqual({
 			period: '7d',
 			scope: '/url-dir'
 		});
 	});

 	test('blank URL scope becomes null regardless of stored scope', () => {
 		const stored: DashboardFilter = { period: '7d', scope: '/stored-dir' };
 		const search = new URLSearchParams('period=7d&scope=');
 		expect(parseFilter(search, ['/stored-dir'], stored)).toEqual({ period: '7d', scope: null });
 	});

 	test('scope=all URL parameter becomes null regardless of stored scope', () => {
 		const stored: DashboardFilter = { period: '7d', scope: '/stored-dir' };
 		const search = new URLSearchParams('period=7d&scope=all');
 		expect(parseFilter(search, ['/stored-dir'], stored)).toEqual({ period: '7d', scope: null });
 	});

 	test('unknown URL scope falls back to stored scope when it is a known directory', () => {
 		const stored: DashboardFilter = { period: '7d', scope: '/known' };
 		const search = new URLSearchParams('period=7d&scope=/ghost');
 		expect(parseFilter(search, ['/known'], stored)).toEqual({ period: '7d', scope: '/known' });
 	});

 	test('unknown URL scope falls back to stored scope normalised through knownScopeOrNull', () => {
 		const stored: DashboardFilter = { period: '7d', scope: '/unknown-stored' };
 		const search = new URLSearchParams('period=7d&scope=/ghost');
 		// Stored scope is not in knownScopes, so it is dropped to null.
 		expect(parseFilter(search, ['/known'], stored)).toEqual({ period: '7d', scope: null });
 	});

 	test('no URL params uses stored period and known-scope-normalised stored scope', () => {
 		const stored: DashboardFilter = { period: '30d', scope: '/mydir' };
 		const search = new URLSearchParams('');
 		expect(parseFilter(search, ['/mydir', '/other'], stored)).toEqual({
 			period: '30d',
			scope: '/mydir'
 		});
 	});

 	test('no URL params with unknown stored scope degrades to default scope', () => {
 		const stored: DashboardFilter = { period: '30d', scope: '/deleted-dir' };
 		const search = new URLSearchParams('');
 		expect(parseFilter(search, ['/other'], stored)).toEqual({ period: '30d', scope: null });
 	});

 	test('2-argument call without stored behaves as pure default', () => {
 		const search = new URLSearchParams('period=7d&scope=/a');
 		expect(parseFilter(search, ['/a'])).toEqual({ period: '7d', scope: '/a' });
 		const empty = parseFilter(new URLSearchParams(), ['/a']);
 		expect(empty).toEqual({ period: DEFAULT_PERIOD, scope: null });
 	});
});

describe('filterSearch()', () => {
	test('serialises period and null scope as all', () => {
		const filter: DashboardFilter = { period: '7d', scope: null };
		const params = filterSearch(filter);
		expect(params.get('period')).toBe('7d');
		expect(params.get('scope')).toBe('all');
	});

	test('serialises a non-null scope verbatim', () => {
		const filter: DashboardFilter = { period: '90d', scope: '/a/b' };
		const params = filterSearch(filter);
		expect(params.get('period')).toBe('90d');
		expect(params.get('scope')).toBe('/a/b');
	});

	test('round-trips through parseFilter', () => {
		const original: DashboardFilter = { period: 'all', scope: '/x' };
		const parsed = parseFilter(filterSearch(original), ['/x']);
		expect(parsed).toEqual(original);
	});

	test('round-trips null scope through all', () => {
		const original: DashboardFilter = { period: '30d', scope: null };
		const parsed = parseFilter(filterSearch(original), []);
		expect(parsed).toEqual(original);
	});

	test('round-trips "today" period through the URL', () => {
		const original: DashboardFilter = { period: 'today', scope: null };
		const parsed = parseFilter(filterSearch(original), []);
		expect(parsed).toEqual(original);
	});

	test('round-trips "3d" period through the URL', () => {
		const original: DashboardFilter = { period: '3d', scope: null };
		const parsed = parseFilter(filterSearch(original), []);
		expect(parsed).toEqual(original);
	});
});

/**
 * Verify filter.ts stays DOM-free and server-free (spec §2.1 contract).
 */
describe('filter.ts stays DOM-free and server-free', () => {
	test('does not import $lib/server, Svelte or the DOM', async () => {
		const source = new URL('./filter.ts', import.meta.url);
		const content = await Bun.file(source).text();
		expect(content).not.toMatch(/from ['"]\$lib\/server/);
		expect(content).not.toMatch(/from ['"]svelte/);
		expect(content).not.toMatch(/\bdocument\.|\bwindow\./);
	});
});
