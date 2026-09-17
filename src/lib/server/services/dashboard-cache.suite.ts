/**
 * Dashboard cache regression suite (task #408).
 *
 * Covers TTL expiry, dbStateToken invalidation, refresh bypass, in-flight
 * dedup, rejected-load-not-cached, LRU eviction, clear via onDbReset, and
 * filter-key distinctness. Uses the injectable `now` clock so TTL tests stay
 * deterministic without a real clock skew.
 *
 * Runs in an isolated child process (see `dashboard-cache.test.ts`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-dashboard-cache-'));
const DB_PATH = join(tempDir, 'fixture.db');

// Build a minimal fixture so dbStateToken() resolves and the module graph loads.
{
	const db = new Database(DB_PATH);
	db.exec(`
		CREATE TABLE session (id TEXT PRIMARY KEY);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
		CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
	`);
	const ins = db.prepare('INSERT INTO session (id) VALUES (?)');
	for (let i = 0; i < 3; i++) ins.run(`s${i}`);
	db.close();
}
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const {
	clearDashboardCache,
	dashboardFilterKey,
	dashboardCacheKey,
	loadDashboardAggregate,
	DASHBOARD_CACHE_TTL_MS,
	DASHBOARD_CACHE_MAX_ENTRIES
} = (await import(spec('../services/dashboard-cache.ts'))) as {
	clearDashboardCache: () => void;
	dashboardFilterKey: (f: { period: string; scope: string | null }) => string;
	dashboardCacheKey: (f: { period: string; scope: string | null }, token?: string) => string;
	loadDashboardAggregate: <T>(
		filter: { period: string; scope: string | null },
		loader: () => T,
		options?: { refresh?: boolean; now?: number }
	) => Promise<T>;
	DASHBOARD_CACHE_TTL_MS: number;
	DASHBOARD_CACHE_MAX_ENTRIES: number;
};

const { resetDbConnection, dbStateToken } = (await import(spec('../db.ts'))) as {
	resetDbConnection: () => void;
	dbStateToken: () => string;
};

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
	clearDashboardCache();
});

/* ------------------------------------------------------------------ */
/* Cache key construction                                             */
/* ------------------------------------------------------------------ */

describe('dashboardCacheKey / dashboardFilterKey', () => {
	test('filter key embeds period and scope (* when null)', () => {
		expect(dashboardFilterKey({ period: '30d', scope: null })).toBe('30d\x00*');
		expect(dashboardFilterKey({ period: '7d', scope: '/repo/a' })).toBe('7d\x00/repo/a');
	});

	test('cache key embeds dbStateToken', () => {
		const token = dbStateToken();
		const key = dashboardCacheKey({ period: '30d', scope: null }, token);
		expect(key).toBe(`30d\x00*\x00${token}`);
	});

	test('distinct filters produce distinct keys', () => {
		const token = dbStateToken();
		const k1 = dashboardCacheKey({ period: '7d', scope: null }, token);
		const k2 = dashboardCacheKey({ period: '30d', scope: null }, token);
		expect(k1).not.toBe(k2);
	});
});

/* ------------------------------------------------------------------ */
/* TTL boundary expiry                                                */
/* ------------------------------------------------------------------ */

describe('TTL expiry', () => {
	const NOW = 1_000_000_000_000;

	test('cache hit before TTL', async () => {
		clearDashboardCache();
		let calls = 0;
		const result = await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => { calls++; return `v-${calls}`; },
			{ now: NOW }
		);
		expect(result).toBe('v-1');
		expect(calls).toBe(1);
		// Second call within TTL -> same result, no extra call.
		const result2 = await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => { calls++; return `v-${calls}`; },
			{ now: NOW + DASHBOARD_CACHE_TTL_MS - 1 }
		);
		expect(result2).toBe('v-1');
		expect(calls).toBe(1);
	});

	test('cache miss exactly at TTL boundary triggers recomputation', async () => {
		clearDashboardCache();
		let calls = 0;
		await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => { calls++; return `v-${calls}`; },
			{ now: NOW }
		);
		expect(calls).toBe(1);
		// At exactly TTL_MS, the entry is expired.
		const result2 = await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => { calls++; return `v-${calls}`; },
			{ now: NOW + DASHBOARD_CACHE_TTL_MS }
		);
		expect(result2).toBe('v-2');
		expect(calls).toBe(2);
	});

	test('in-flight entry is never evicted early past TTL', async () => {
		clearDashboardCache();
		let calls = 0;
		const promise = loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => {
				calls++;
				// Simulate a slow loader that does not resolve yet.
				return new Promise<string>((resolve) => {
					setTimeout(() => resolve(`slow-v-${calls}`), 50);
				});
			},
			{ now: NOW }
		);
		// While in-flight (settled=false), a concurrent request at TTL+1 should
		// still wait on the same promise, not re-run the loader.
		const promise2 = loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => { calls++; return `v-${calls}`; },
			{ now: NOW + DASHBOARD_CACHE_TTL_MS + 1 }
		);
		const [r1, r2] = await Promise.all([promise, promise2]);
		expect(r1).toBe(r2); // same promise returned
		expect(calls).toBe(1); // loader ran only once
	});
});

/* ------------------------------------------------------------------ */
/* dbStateToken invalidation                                          */
/* ------------------------------------------------------------------ */

describe('dbStateToken invalidation', () => {
	test('a new dbStateToken clears the whole cache', async () => {
		clearDashboardCache();
		await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => 'v-1',
			{ now: 1000 }
		);
		// Force a new token by resetting the DB connection.
		resetDbConnection();
		// The cached entry must be dropped — next call recomputes.
		const result = await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => 'v-2',
			{ now: 2000 }
		);
		expect(result).toBe('v-2');
	});
});

/* ------------------------------------------------------------------ */
/* refresh bypass                                                     */
/* ------------------------------------------------------------------ */

describe('refresh bypass', () => {
	test('refresh=true skips the cache and recomputes', async () => {
		clearDashboardCache();
		let calls = 0;
		await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => { calls++; return `v-${calls}`; },
			{ now: 1000 }
		);
		expect(calls).toBe(1);
		const refreshed = await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => { calls++; return `v-${calls}`; },
			{ now: 1000, refresh: true }
		);
		expect(refreshed).toBe('v-2');
		expect(calls).toBe(2);
	});

	test('refresh bypasses only the requested filter; other filters stay warm', async () => {
		clearDashboardCache();
		let calls7d = 0;
		let calls30d = 0;
		await loadDashboardAggregate({ period: '7d', scope: null }, () => { calls7d++; return '7d-v1'; }, { now: 1000 });
		await loadDashboardAggregate({ period: '30d', scope: null }, () => { calls30d++; return '30d-v1'; }, { now: 1000 });
		expect(calls7d).toBe(1);
		expect(calls30d).toBe(1);
		// Refresh only 7d.
		const r7d = await loadDashboardAggregate(
			{ period: '7d', scope: null },
			() => { calls7d++; return '7d-v2'; },
			{ now: 1000, refresh: true }
		);
		expect(r7d).toBe('7d-v2');
		expect(calls7d).toBe(2);
		// 30d should still be cached.
		const r30d = await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => { calls30d++; return '30d-v2'; },
			{ now: 1000 }
		);
		expect(r30d).toBe('30d-v1');
		expect(calls30d).toBe(1);
	});
});

/* ------------------------------------------------------------------ */
/* In-flight dedup                                                    */
/* ------------------------------------------------------------------ */

describe('in-flight dedup', () => {
	test('concurrent callers for the same key share one loader invocation', async () => {
		clearDashboardCache();
		let calls = 0;
		const p1 = loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => {
				calls++;
				return new Promise<string>((resolve) => setTimeout(() => resolve(`v-${calls}`), 30));
			},
			{ now: 1000 }
		);
		const p2 = loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => { calls++; return `v-${calls}`; },
			{ now: 1000 }
		);
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toBe(r2);
		expect(calls).toBe(1);
	});
});

/* ------------------------------------------------------------------ */
/* Rejected loads are not cached                                      */
/* ------------------------------------------------------------------ */

describe('rejected-load-not-cached', () => {
	test('a throwing loader is not cached; a subsequent call recomputes', async () => {
		clearDashboardCache();
		let calls = 0;
		await expect(
			loadDashboardAggregate(
				{ period: '30d', scope: null },
				() => { calls++; throw new Error('boom'); },
				{ now: 1000 }
			)
		).rejects.toThrow('boom');
		// Loader should have been called once.
		expect(calls).toBe(1);
		// Second call should re-run the loader (the failed entry was evicted).
		await expect(
			loadDashboardAggregate(
				{ period: '30d', scope: null },
				() => { calls++; return 'v-2'; },
				{ now: 1000 }
			)
		).resolves.toBe('v-2');
		expect(calls).toBe(2);
	});
});

/* ------------------------------------------------------------------ */
/* LRU eviction                                                       */
/* ------------------------------------------------------------------ */

describe('LRU eviction', () => {
	test('evicts the least-recently-used entry when the cache is full', async () => {
		clearDashboardCache();
		// Fill the cache up to DASHBOARD_CACHE_MAX_ENTRIES.
		for (let i = 0; i < DASHBOARD_CACHE_MAX_ENTRIES; i++) {
			await loadDashboardAggregate(
				{ period: '30d', scope: `/repo/${i}` },
				() => `v-${i}`,
				{ now: 1000 + i }
			);
		}
		// Touch /repo/0 to make it recently used (move to end of Map order).
		await loadDashboardAggregate(
			{ period: '30d', scope: '/repo/0' },
			() => 'v-0-hit',
			{ now: 9000 }
		);
		// Insert one more filter — the oldest unused entry (/repo/1) should be evicted.
		await loadDashboardAggregate(
			{ period: '30d', scope: '/repo/new' },
			() => 'v-new',
			{ now: 10000 }
		);
		// /repo/1 should have been evicted and recomputed.
		const evicted = await loadDashboardAggregate(
			{ period: '30d', scope: '/repo/1' },
			() => 'v-1-recomputed',
			{ now: 11000 }
		);
		expect(evicted).toBe('v-1-recomputed');
	});
});

/* ------------------------------------------------------------------ */
/* Clear hooks                                                        */
/* ------------------------------------------------------------------ */

describe('clear hooks: onDbReset / onSettingsChange', () => {
	test('resetDbConnection clears the cache', async () => {
		clearDashboardCache();
		await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => 'v-1',
			{ now: 1000 }
		);
		resetDbConnection();
		// After reset, next call must recompute.
		const result = await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => 'v-2',
			{ now: 2000 }
		);
		expect(result).toBe('v-2');
	});

	test('clearDashboardCache is a no-op when already empty', async () => {
		clearDashboardCache();
		// Should not throw.
		expect(() => clearDashboardCache()).not.toThrow();
	});
});

/* ------------------------------------------------------------------ */
/* Filter-key distinctness                                            */
/* ------------------------------------------------------------------ */

describe('filter-key distinctness', () => {
	test('different periods produce independent cached values', async () => {
		clearDashboardCache();
		const r7d = await loadDashboardAggregate(
			{ period: '7d', scope: null },
			() => '7d-result',
			{ now: 1000 }
		);
		const r30d = await loadDashboardAggregate(
			{ period: '30d', scope: null },
			() => '30d-result',
			{ now: 1000 }
		);
		expect(r7d).toBe('7d-result');
		expect(r30d).toBe('30d-result');
	});

	test('different scopes produce independent cached values', async () => {
		clearDashboardCache();
		const rA = await loadDashboardAggregate(
			{ period: '30d', scope: '/repo/a' },
			() => 'repo-a',
			{ now: 1000 }
		);
		const rB = await loadDashboardAggregate(
			{ period: '30d', scope: '/repo/b' },
			() => 'repo-b',
			{ now: 1000 }
		);
		expect(rA).toBe('repo-a');
		expect(rB).toBe('repo-b');
	});

	test('same period but different settings signature produce independent cached values', async () => {
		clearDashboardCache();
		// Scope format: `<period>\0<scope>\0<widgetId>\0<signature>`
		const sigA = 'basic=1|mcp=0';
		const sigB = 'basic=0|mcp=0';
		const rA = await loadDashboardAggregate(
			{ period: '30d', scope: `*\u0000top-tools\u0000${sigA}` },
			() => 'basic-true',
			{ now: 1000 }
		);
		const rB = await loadDashboardAggregate(
			{ period: '30d', scope: `*\u0000top-tools\u0000${sigB}` },
			() => 'basic-false',
			{ now: 1000 }
		);
		expect(rA).toBe('basic-true');
		expect(rB).toBe('basic-false');
	});

	test('same period and same settings signature reuses the cached entry', async () => {
		clearDashboardCache();
		let calls = 0;
		const sig = 'basic=1|mcp=0';
		const r1 = await loadDashboardAggregate(
			{ period: '30d', scope: `*\u0000top-tools\u0000${sig}` },
			() => { calls++; return 'v1'; },
			{ now: 1000 }
		);
		const r2 = await loadDashboardAggregate(
			{ period: '30d', scope: `*\u0000top-tools\u0000${sig}` },
			() => { calls++; return 'v2'; },
			{ now: 1000 }
		);
		expect(r1).toBe('v1');
		expect(r2).toBe('v1'); // same cache entry, not recomputed
		expect(calls).toBe(1); // loader ran only once
	});
});
