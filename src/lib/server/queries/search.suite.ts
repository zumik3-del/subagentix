/**
 * U1 `?q=` search suite — literal `LIKE` wildcard escaping (task #208).
 *
 * This file intentionally has NO `.test` suffix: it opens a real fixture SQLite
 * DB through `$lib/server/db`, and `health.test.ts` installs a process-wide
 * `mock.module('$lib/server/db', ...)` that bun cannot undo. The wrapper
 * `search.test.ts` spawns it in an isolated child `bun test` process (pattern
 * from `data-layer.suite.ts`).
 *
 * The fixture is crafted so a *broken* `escapeLike` fails the assertions in
 * both directions: an unescaped `%`/`_` would over-match (`a%b` -> `axxb`),
 * and an unescaped trailing `\` would escape the next character
 * (`sl\ash` -> `slash`). The live opencode DB is never opened or written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T = 1_700_000_000_000;

const SCHEMA = `
	CREATE TABLE session (
		id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT,
		time_created INTEGER, time_updated INTEGER, time_archived INTEGER, cost REAL,
		tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
		tokens_cache_read INTEGER, tokens_cache_write INTEGER, model TEXT
	);
	CREATE INDEX session_parent_idx ON session(parent_id);
	CREATE TABLE message (
		id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
	);
	CREATE INDEX message_session_idx ON message(session_id);
	CREATE TABLE part (
		id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
		time_created INTEGER, time_updated INTEGER, data TEXT
	);
	CREATE INDEX part_session_idx ON part(session_id);
	CREATE TABLE event (
		id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT
	);
`;

/**
 * Ten roots with `%`/`_`/`\` in exactly one searchable field, plus decoys that
 * only match when the wildcards are left unescaped, and one child that must
 * never surface. `time_created` ascends with the id order.
 */
function buildFixture(path: string): void {
	const db = new Database(path);
	db.exec(SCHEMA);

	const insSession = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	let i = 0;
	const addRoot = (id: string, directory: string, title: string): void => {
		const created = T + i++;
		insSession.run(id, null, directory, title, 'build', created, created + 10, null, 0, 0, 0, 0, 0, 0, null);
	};
	addRoot('plain', '/repo/plain', 'Plain root');
	addRoot('pct', '/repo/pct', '100% done');
	addRoot('amb', '/repo/like', 'a%b literal');
	addRoot('axxb', '/repo/like', 'axxb value'); // decoy for `a%b`
	addRoot('und', '/repo/like', 'a_b token');
	addRoot('axb', '/repo/like', 'axb token'); // decoy for `a_b`
	addRoot('back', '/repo/like', 'sl\\ash');
	addRoot('slash', '/repo/like', 'slash'); // decoy for `sl\ash`
	addRoot('wdir', '/repo/we%ird', 'Weird dir');
	addRoot('inj', '/repo/inject', "' OR 1=1 --");
	// A non-root with a matching title must never appear in root search.
	insSession.run(
		'pctchild',
		'pct',
		'/repo/pct',
		'100% child',
		'developer',
		T + 900,
		T + 900,
		null,
		0,
		0,
		0,
		0,
		0,
		0,
		null
	);

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-u1-search-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

/** Absolute specifier so Bun resolves relative to this file. */
function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const { listRecentRootSessions, countRecentRootSessions } = (await import(
	spec('./sessions.ts')
)) as {
	listRecentRootSessions: (
		limit: number,
		directory?: string,
		offset?: number,
		query?: string
	) => Array<{ id: string }>;
	countRecentRootSessions: (directory?: string, query?: string) => number;
};
const { getDb } = (await import(spec('../db.ts'))) as {
	getDb: () => {
		query: (sql: string) => { get: () => unknown };
	};
};
const listRoute = (await import(spec('../../../routes/api/sessions/+server.ts'))) as {
	GET: (event: { url: URL }) => Response;
};

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/** Sorted root ids returned by the query layer for `q`. */
function ids(q: string): string[] {
	return listRecentRootSessions(50, undefined, 0, q)
		.map((session) => session.id)
		.sort();
}

/** Sorted root ids returned by `GET /api/sessions?q=`. */
async function routeIds(q: string): Promise<string[]> {
	const url = new URL('http://localhost/api/sessions');
	url.searchParams.set('q', q);
	const response = listRoute.GET({ url });
	expect(response.status).toBe(200);
	return ((await response.json()) as Array<{ id: string }>)
		.map((row) => row.id)
		.sort();
}

describe('search filter — bound parameters and literal wildcard escaping', () => {
	test('% searches for a literal percent, never a wildcard', () => {
		expect(ids('100%')).toEqual(['pct']);
		// If unescaped, `%a%b%` would also match the `axxb plain` decoy.
		expect(ids('a%b')).toEqual(['amb']);
		// Only fields containing a literal `%` match: two titles + one directory.
		expect(ids('%')).toEqual(['amb', 'pct', 'wdir']);
	});

	test('_ searches for a literal underscore, never a single-char wildcard', () => {
		// If unescaped, `%a_b%` would also match the `axb token` decoy.
		expect(ids('a_b')).toEqual(['und']);
		// Case-insensitivity still applies to the literals around the wildcard.
		expect(ids('A_B')).toEqual(['und']);
	});

	test('a backslash is escaped so it cannot escape the next character', () => {
		// Escaped `sl\ash` -> `%sl\\ash%` matches the literal title only.
		// Unescaped it would collapse `\a` to `a` and match `slash` instead.
		expect(ids('sl\\ash')).toEqual(['back']);
		// A lone backslash matches the one title that contains one.
		expect(ids('\\')).toEqual(['back']);
	});

	test('directory search is escaped exactly like title search', () => {
		expect(ids('we%ird')).toEqual(['wdir']);
		expect(ids('weXird')).toEqual([]);
	});

	test('quotes / SQL metacharacters are bound values, not injected SQL', () => {
		// If interpolated, `' OR 1=1 --` would match every root.
		expect(ids("' OR 1=1 --")).toEqual(['inj']);
		expect(countRecentRootSessions(undefined, "' OR 1=1 --")).toBe(1);
	});

	test('matching is case-insensitive over title, id and directory', () => {
		expect(ids('PLAIN')).toEqual(['plain']);
		expect(ids('WEIRD')).toEqual(['wdir']); // title "Weird dir"
		expect(ids('AXB')).toEqual(['axb']); // id + title, not `axxb`
	});

	test('child sessions never surface in a root-session search', () => {
		// `pctchild` has a matching title but a non-null parent_id.
		expect(ids('child')).toEqual([]);
		expect(countRecentRootSessions(undefined, 'child')).toBe(0);
	});

	test('blank / whitespace-only queries are unfiltered', () => {
		for (const q of ['', '   ', '\t\n']) {
			expect(ids(q)).toHaveLength(10);
			expect(countRecentRootSessions(undefined, q)).toBe(10);
		}
	});

	test('search combines with the directory filter and respects roots only', () => {
		expect(listRecentRootSessions(50, '/repo/like', 0, 'a%b').map((s) => s.id)).toEqual(['amb']);
		expect(countRecentRootSessions('/repo/pct', '100%')).toBe(1);
		expect(countRecentRootSessions('/repo/plain', '100%')).toBe(0);
		// `pct` is a root; its `pctchild` child is not counted.
		expect(countRecentRootSessions(undefined, '100%')).toBe(1);
	});

	test('the search performs no writes and keeps query_only', () => {
		const db = getDb();
		const snapshot = {
			session: (db.query('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n,
			message: (db.query('SELECT COUNT(*) AS n FROM message').get() as { n: number }).n,
			part: (db.query('SELECT COUNT(*) AS n FROM part').get() as { n: number }).n,
			event: (db.query('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n
		};
		for (const q of ['a%b', '_', '\\', '%', "' OR 1=1 --", '']) {
			listRecentRootSessions(50, undefined, 0, q);
			countRecentRootSessions(undefined, q);
		}
		expect({
			session: (db.query('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n,
			message: (db.query('SELECT COUNT(*) AS n FROM message').get() as { n: number }).n,
			part: (db.query('SELECT COUNT(*) AS n FROM part').get() as { n: number }).n,
			event: (db.query('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n
		}).toEqual(snapshot);
		expect(db.query('PRAGMA query_only').get()).toEqual({ query_only: 1 });
	});
});

describe('GET /api/sessions?q= — route-level escaping', () => {
	test('passes %/_, the backslash and limit/offset through the route', async () => {
		expect(await routeIds('100%')).toEqual(['pct']);
		expect(await routeIds('a_b')).toEqual(['und']);
		expect(await routeIds('a%b')).toEqual(['amb']);
		expect(await routeIds('sl\\ash')).toEqual(['back']);

		const url = new URL('http://localhost/api/sessions');
		url.searchParams.set('q', 'a%b');
		url.searchParams.set('limit', '5');
		url.searchParams.set('offset', '0');
		const response = listRoute.GET({ url });
		expect(response.status).toBe(200);
		expect(((await response.json()) as unknown[]).map((r) => (r as { id: string }).id)).toEqual([
			'amb'
		]);
	});

	test('an empty q is unfiltered and a non-match is an empty array', async () => {
		expect((await routeIds('')).length).toBe(10);
		expect(await routeIds('no-such-thing')).toEqual([]);
	});
});
