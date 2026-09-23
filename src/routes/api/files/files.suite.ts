/**
 * Files API route suite (epic #775, task #780).
 *
 * Covers AC2.a–AC2.c and the route-layer mapping of service statuses to HTTP
 * codes. Uses throwaway temp-dir fixtures and a real fixture SQLite DB.
 *
 * Runs in an isolated child `bun test` process (see `files.test.ts` wrapper).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ------------------------------------------------------------------ */
/* Fixture scaffolding                                                */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = [];

function tempDir(prefix = 'subagentix-files-route-'): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function buildFixtureDb(
	dir: string,
	projects: Array<{ id: string; worktree: string; name: string }>
): string {
	const dbPath = join(dir, 'fixture.db');
	const db = new Database(dbPath);
	db.exec(`
		CREATE TABLE project (
			id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT,
			vcs TEXT, icon_url TEXT, icon_color TEXT,
			time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
			time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT,
			icon_url_override TEXT
		);
	`);
	const ins = db.prepare(
		'INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)'
	);
	for (const p of projects) {
		ins.run(p.id, p.worktree, p.name, 0, 0, '[]');
	}
	db.close();
	return dbPath;
}

function buildGlobalFixture(dir: string): string {
	const root = join(dir, 'global-config');
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'AGENTS.md'), '# Global\n');
	mkdirSync(join(root, 'agents'), { recursive: true });
	writeFileSync(join(root, 'agents', 'developer.md'), 'dev\n');
	writeFileSync(join(root, 'opencode.json'), '{}\n');
	return root;
}

function buildProjectFixture(dir: string): string {
	const root = join(dir, 'project-worktree');
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'AGENTS.md'), '# Project\n');
	writeFileSync(join(root, 'opencode.json'), '{}\n');
	return root;
}

/* ------------------------------------------------------------------ */
/* Import helpers                                                     */
/* ------------------------------------------------------------------ */

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

/* ------------------------------------------------------------------ */
/* AC2.a: GET /api/files                                              */
/* ------------------------------------------------------------------ */

describe('AC2.a: GET /api/files', () => {
	let dir: string;
	let globalRoot: string;
	let projectRoot: string;
	let dbPath: string;

	beforeEach(() => {
		dir = tempDir('ac2a-');
		globalRoot = buildGlobalFixture(dir);
		projectRoot = buildProjectFixture(dir);
		dbPath = buildFixtureDb(dir, [
			{ id: 'proj-route', worktree: projectRoot, name: 'Route Proj' }
		]);
		process.env.OPENCODE_CONFIG_DIR = globalRoot;
		process.env.OPENCODE_DB = dbPath;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
	});

	afterEach(() => {
		delete process.env.OPENCODE_CONFIG_DIR;
		delete process.env.OPENCODE_DB;
		delete process.env.SETTINGS_FILE;
	});

	test('returns 200 with a FileIndex containing global + project blocks', async () => {
		const { GET } = (await import(spec('./+server.ts'))) as {
			GET: () => Promise<Response>;
		};
		const response = await GET();
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			blocks: Array<{ id: string; scope: string; name: string; available: boolean }>;
			projectsAvailable: boolean;
		};
		expect(body.projectsAvailable).toBe(true);
		const ids = body.blocks.map((b) => b.id);
		expect(ids).toContain('global');
		expect(ids).toContain('project:proj-route');
		expect(body.blocks).toHaveLength(2);
	});

	test('returns global block even when the DB is missing (projectsAvailable:false)', async () => {
		const missingDb = join(dir, 'missing.db');
		process.env.OPENCODE_DB = missingDb;

		const { GET } = (await import(spec('./+server.ts'))) as {
			GET: () => Promise<Response>;
		};
		const response = await GET();
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			blocks: Array<{ id: string }>;
			projectsAvailable: boolean;
		};
		expect(body.projectsAvailable).toBe(false);
		expect(body.blocks).toHaveLength(1);
		expect(body.blocks[0].id).toBe('global');
	});
});

/* ------------------------------------------------------------------ */
/* AC2.b / AC2.c: GET /api/files/content                              */
/* ------------------------------------------------------------------ */

describe('AC2.b / AC2.c: GET /api/files/content', () => {
	let dir: string;
	let globalRoot: string;
	let projectRoot: string;
	let dbPath: string;

	beforeEach(() => {
		dir = tempDir('ac2bc-');
		globalRoot = buildGlobalFixture(dir);
		projectRoot = buildProjectFixture(dir);
		dbPath = buildFixtureDb(dir, [
			{ id: 'proj-c', worktree: projectRoot, name: 'Content Proj' }
		]);
		process.env.OPENCODE_CONFIG_DIR = globalRoot;
		process.env.OPENCODE_DB = dbPath;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
	});

	afterEach(() => {
		delete process.env.OPENCODE_CONFIG_DIR;
		delete process.env.OPENCODE_DB;
		delete process.env.SETTINGS_FILE;
	});

	function makeUrl(params: Record<string, string>): URL {
		const u = new URL('http://localhost/api/files/content');
		for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
		return u;
	}

	test('AC2.c: missing block param -> 400 { error, field: "block" }', async () => {
		const { GET } = (await import(spec('./content/+server.ts'))) as {
			GET: (event: { url: URL }) => Promise<Response>;
		};
		const response = await GET({ url: makeUrl({ path: 'AGENTS.md' }) });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; field?: string };
		expect(body.field).toBe('block');
		expect(typeof body.error).toBe('string');
	});

	test('AC2.c: missing path param -> 400 { error, field: "path" }', async () => {
		const { GET } = (await import(spec('./content/+server.ts'))) as {
			GET: (event: { url: URL }) => Promise<Response>;
		};
		const response = await GET({ url: makeUrl({ block: 'global' }) });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; field?: string };
		expect(body.field).toBe('path');
	});

	test('AC2.c: blank block -> 400', async () => {
		const { GET } = (await import(spec('./content/+server.ts'))) as {
			GET: (event: { url: URL }) => Promise<Response>;
		};
		const response = await GET({ url: makeUrl({ block: '', path: 'AGENTS.md' }) });
		expect(response.status).toBe(400);
	});

	test('AC2.b: valid file -> 200 with FileContent shape', async () => {
		const { GET } = (await import(spec('./content/+server.ts'))) as {
			GET: (event: { url: URL }) => Promise<Response>;
		};
		const response = await GET({ url: makeUrl({ block: 'global', path: 'AGENTS.md' }) });
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = (await response.json()) as {
			block: string;
			path: string;
			content: string | null;
			binary: boolean;
			size: number;
			mtimeMs: number;
		};
		expect(body.block).toBe('global');
		expect(body.path).toBe('AGENTS.md');
		expect(body.binary).toBe(false);
		expect(typeof body.content).toBe('string');
		expect(body.size).toBeGreaterThan(0);
		expect(typeof body.mtimeMs).toBe('number');
	});

	test('AC2.b: unknown block -> 404', async () => {
		const { GET } = (await import(spec('./content/+server.ts'))) as {
			GET: (event: { url: URL }) => Promise<Response>;
		};
		const response = await GET({
			url: makeUrl({ block: 'project:nonexistent', path: 'AGENTS.md' })
		});
		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: string };
		expect(typeof body.error).toBe('string');
	});

	test('AC2.b: traversal path -> 400', async () => {
		const { GET } = (await import(spec('./content/+server.ts'))) as {
			GET: (event: { url: URL }) => Promise<Response>;
		};
		const response = await GET({ url: makeUrl({ block: 'global', path: '../AGENTS.md' }) });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; field?: string };
		expect(body.field).toBe('path');
	});

	test('AC2.b: symlink escape -> 400', async () => {
		const outside = join(dir, 'outside');
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, 'secret.txt'), 'leaked\n');
		const linkPath = join(globalRoot, 'agents', 'leak.md');
		symlinkSync(join(outside, 'secret.txt'), linkPath);

		const { GET } = (await import(spec('./content/+server.ts'))) as {
			GET: (event: { url: URL }) => Promise<Response>;
		};
		const response = await GET({ url: makeUrl({ block: 'global', path: 'agents/leak.md' }) });
		expect(response.status).toBe(400);

		// Clean up symlink so afterAll cleanup works.
		rmSync(linkPath, { force: true });
	});

	test('AC2.b: Cache-Control: no-store on every response', async () => {
		const { GET } = (await import(spec('./content/+server.ts'))) as {
			GET: (event: { url: URL }) => Promise<Response>;
		};
		const ok = await GET({ url: makeUrl({ block: 'global', path: 'AGENTS.md' }) });
		expect(ok.headers.get('cache-control')).toBe('no-store');
		const notFound = await GET({ url: makeUrl({ block: 'global', path: 'missing.md' }) });
		expect(notFound.headers.get('cache-control')).toBe('no-store');
		const bad = await GET({ url: makeUrl({ block: 'global', path: '../x' }) });
		expect(bad.headers.get('cache-control')).toBe('no-store');
	});
});

/* ------------------------------------------------------------------ */
/* Route-level size cap (413)                                         */
/* ------------------------------------------------------------------ */

describe('Route 413: oversized file', () => {
	let dir: string;
	let globalRoot: string;
	let dbPath: string;

	beforeEach(() => {
		dir = tempDir('ac413-');
		globalRoot = buildGlobalFixture(dir);
		dbPath = buildFixtureDb(dir, []);
		process.env.OPENCODE_CONFIG_DIR = globalRoot;
		process.env.OPENCODE_DB = dbPath;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
	});

	afterEach(() => {
		delete process.env.OPENCODE_CONFIG_DIR;
		delete process.env.OPENCODE_DB;
		delete process.env.SETTINGS_FILE;
	});

	test('file > 512 KiB -> 413 with size and limit', async () => {
		const big = 'x'.repeat(512 * 1024 + 1);
		writeFileSync(join(globalRoot, 'opencode.json'), big);

		const { GET } = (await import(spec('./content/+server.ts'))) as {
			GET: (event: { url: URL }) => Promise<Response>;
		};
		const response = await GET({
			url: new URL('http://localhost/api/files/content?block=global&path=opencode.json')
		});
		expect(response.status).toBe(413);
		const body = (await response.json()) as { error: string; size: number; limit: number };
		expect(body.limit).toBe(512 * 1024);
		expect(body.size).toBeGreaterThan(512 * 1024);
	});
});

/* ------------------------------------------------------------------ */
/* Route-level EACCES (403)                                           */
/* ------------------------------------------------------------------ */

describe('Route 403: unreadable file', () => {
	let dir: string;
	let globalRoot: string;
	let dbPath: string;

	beforeEach(() => {
		dir = tempDir('ac403-');
		globalRoot = buildGlobalFixture(dir);
		dbPath = buildFixtureDb(dir, []);
		process.env.OPENCODE_CONFIG_DIR = globalRoot;
		process.env.OPENCODE_DB = dbPath;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
	});

	afterEach(() => {
		delete process.env.OPENCODE_CONFIG_DIR;
		delete process.env.OPENCODE_DB;
		delete process.env.SETTINGS_FILE;
	});

	test('EACCES on allowlisted file -> 403', async () => {
		const target = join(globalRoot, 'opencode.json');
		const original = readFileSync(target);
		chmodSync(target, 0o000);
		try {
			const { GET } = (await import(spec('./content/+server.ts'))) as {
				GET: (event: { url: URL }) => Promise<Response>;
			};
			const response = await GET({
				url: new URL('http://localhost/api/files/content?block=global&path=opencode.json')
			});
			expect(response.status).toBe(403);
			const body = (await response.json()) as { error: string };
			expect(typeof body.error).toBe('string');
		} finally {
			chmodSync(target, 0o644);
			writeFileSync(target, original);
		}
	});
});
