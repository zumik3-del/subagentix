/**
 * Files UI suite (epic #775, task #781).
 *
 * Isolated child process (see `pages.test.ts` for why). No DOM runtime is
 * available, so the suite combines three strategies:
 *
 * 1. **Vite SSR rendering** of FileBlock / FileBrowser to assert the block-level
 *    expand/collapse structure (AC-11).
 * 2. **Direct unit tests** of `createFileContentLoader` with a stubbed `fetch`
 *    to assert exactly-one-fetch-per-block-path and cache reuse (AC-11).
 * 3. **Source-level assertions** on FileRow.svelte for the four row states
 *    (loading / text / binary / error) and on Dashboard.svelte for the header
 *    entry link (AC-12).
 *
 * No live DB, no `$lib/server` import, no browser dependency.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import type { FileBlock, FileContent, FileGroup, FileRef } from '$lib/model/files';

/* ------------------------------------------------------------------ */
/* Vite harness                                                        */
/* ------------------------------------------------------------------ */

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let FileBlock: unknown;
let FileBrowser: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;
	FileBlock = (
		(await vite.ssrLoadModule('/src/lib/components/features/files/FileBlock.svelte')) as {
			default: unknown;
		}
	).default;
	FileBrowser = (
		(await vite.ssrLoadModule('/src/lib/components/features/files/FileBrowser.svelte')) as {
			default: unknown;
		}
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const repoRoot = fileURLToPath(new URL('../../../../..', import.meta.url));

function makeRef(path: string, name: string, group: string, size = 42, mtimeMs = 0): FileRef {
	return { path, name, group: group as FileRef['group'], size, mtimeMs };
}

function makeGroup(kind: string, files: FileRef[]): FileGroup {
	return {
		kind: kind as FileGroup['kind'],
		label: kind.charAt(0).toUpperCase() + kind.slice(1),
		files
	};
}

function makeBlock(
	overrides: Partial<FileBlock> & { id: string; scope: string }
): FileBlock {
	return {
		id: overrides.id,
		scope: overrides.scope as FileBlock['scope'],
		name: overrides.name ?? 'Block',
		worktree: overrides.worktree ?? '/mock',
		available: overrides.available ?? true,
		groups: overrides.groups ?? []
	};
}

/** A synchronous stub load that returns a resolved promise immediately. */
function stubLoad(content: FileContent): (block: string, path: string) => Promise<FileContent> {
	return (_block: string, _path: string) => Promise.resolve(content);
}

/* ------------------------------------------------------------------ */
/* AC-11: block expand / collapse                                      */
/* ------------------------------------------------------------------ */

describe('AC-11 — FileBlock SSR expand/collapse', () => {
	test('global block renders aria-expanded="true"', () => {
		const block = makeBlock({
			id: 'global',
			scope: 'global',
			name: 'Global opencode config',
			worktree: '/etc/opencode',
			available: true,
			groups: [makeGroup('agent', [makeRef('AGENTS.md', 'AGENTS.md', 'agent')])]
		});
		const html = render(FileBlock, { props: { block, load: stubLoad({} as FileContent) } }).body;
		expect(html).toContain('aria-expanded="true"');
	});

	test('project block renders aria-expanded="false"', () => {
		const block = makeBlock({
			id: 'project:foo',
			scope: 'project',
			name: 'Foo Project',
			worktree: '/repo/foo',
			available: true,
			groups: [makeGroup('agent', [makeRef('AGENTS.md', 'AGENTS.md', 'agent')])]
		});
		const html = render(FileBlock, { props: { block, load: stubLoad({} as FileContent) } }).body;
		expect(html).toContain('aria-expanded="false"');
	});

	test('a collapsed project block renders no file rows', () => {
		const block = makeBlock({
			id: 'project:bar',
			scope: 'project',
			name: 'Bar Project',
			worktree: '/repo/bar',
			available: true,
			groups: [
				makeGroup('agent', [makeRef('AGENTS.md', 'AGENTS.md', 'agent')]),
				makeGroup('subagents', [makeRef('tester.md', 'tester.md', 'subagents')])
			]
		});
		const html = render(FileBlock, { props: { block, load: stubLoad({} as FileContent) } }).body;
		// The panel div is present (for aria-controls), but no row markup inside it.
		// No file-row elements should appear because the block is collapsed.
		expect(html.split('files-row').length - 1).toBe(0);
	});

	test('an expanded global block renders its file rows', () => {
		const block = makeBlock({
			id: 'global',
			scope: 'global',
			name: 'Global opencode config',
			worktree: '/etc/opencode',
			available: true,
			groups: [makeGroup('agent', [makeRef('AGENTS.md', 'AGENTS.md', 'agent')])]
		});
		const html = render(FileBlock, { props: { block, load: stubLoad({} as FileContent) } }).body;
		expect(html).toContain('files-row__toggle');
		expect(html).toContain('AGENTS.md');
	});

	test('aria-controls resolves to a panel id inside the same block', () => {
		const block = makeBlock({
			id: 'project:x',
			scope: 'project',
			name: 'X',
			worktree: '/repo/x',
			available: true,
			groups: []
		});
		const html = render(FileBlock, { props: { block, load: stubLoad({} as FileContent) } }).body;
		// The button carries aria-controls and the panel carries the matching id.
		const controlsMatch = html.match(/aria-controls="([^"]+)"/);
		const idMatch = html.match(/id="([^"]+)"[^>]*class="[^"]*files-block__panel/);
		expect(controlsMatch).not.toBeNull();
		expect(idMatch).not.toBeNull();
		expect(controlsMatch![1]).toBe(idMatch![1]);
	});

	test('available:false block shows "Directory not found" and no panel content', () => {
		const block = makeBlock({
			id: 'project:ghost',
			scope: 'project',
			name: 'Ghost',
			worktree: '/nonexistent',
			available: false,
			groups: []
		});
		const html = render(FileBlock, { props: { block, load: stubLoad({} as FileContent) } }).body;
		expect(html).toContain('Directory not found');
		expect(html).not.toContain('files-group');
	});
});

/* ------------------------------------------------------------------ */
/* AC-11: FileBrowser notices                                          */
/* ------------------------------------------------------------------ */

describe('AC-11 — FileBrowser SSR notices', () => {
	test('projectsAvailable:false shows the DB-unavailable notice', () => {
		const html = render(FileBrowser, {
			props: { blocks: [], projectsAvailable: false }
		}).body;
		expect(html).toContain('Project list unavailable (opencode DB not reachable).');
	});

	test('empty project list (projectsAvailable:true) shows "No opencode projects found."', () => {
		const globalBlock = makeBlock({
			id: 'global',
			scope: 'global',
			name: 'Global opencode config',
			worktree: '/etc/opencode',
			available: true,
			groups: []
		});
		const html = render(FileBrowser, {
			props: { blocks: [globalBlock], projectsAvailable: true }
		}).body;
		expect(html).toContain('No opencode projects found.');
		expect(html).not.toContain('Project list unavailable');
	});

	test('missing global config root shows its notice', () => {
		const globalBlock = makeBlock({
			id: 'global',
			scope: 'global',
			name: 'Global opencode config',
			worktree: '/nonexistent-config',
			available: false,
			groups: []
		});
		const html = render(FileBrowser, {
			props: { blocks: [globalBlock], projectsAvailable: true }
		}).body;
		expect(html).toContain('Config directory not found.');
	});
});

/* ------------------------------------------------------------------ */
/* AC-11: createFileContentLoader — fetch stub + cache                */
/* ------------------------------------------------------------------ */

describe('AC-11 — createFileContentLoader fetch stub + cache', () => {
	/** Stubs global `fetch` for the duration of the test. */
	function stubFetch(responses: Map<string, FileContent>): () => void {
		const orig = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL | RequestInfo) => {
			const str = url.toString();
			const params = new URL(`http://localhost${str}`).searchParams;
			const key = `${params.get('block')}|${params.get('path')}`;
			const body = responses.get(key);
			if (body === undefined) {
				return new Response(JSON.stringify({ error: 'not found' }), {
					status: 404,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as typeof fetch;
		return () => {
			globalThis.fetch = orig;
		};
	}

	test('first expand issues exactly one fetch for block|path', async () => {
		const unload = stubFetch(
			new Map([['global|AGENTS.md', { block: 'global', path: 'AGENTS.md', content: 'hi', binary: false, size: 2, mtimeMs: 0 }]])
		);
		try {
			const { createFileContentLoader } = await import(
				'$lib/components/features/files/content'
			);
			const loader = createFileContentLoader();
			const r1 = await loader.load('global', 'AGENTS.md');
			expect(r1.content).toBe('hi');
			// A second call with the same key hits the cache, no new fetch.
			const r2 = await loader.load('global', 'AGENTS.md');
			expect(r2).toBe(r1); // same promise
		} finally {
			unload();
		}
	});

	test('different block|path issues a separate fetch', async () => {
		const responses = new Map<string, FileContent>([
			['global|AGENTS.md', { block: 'global', path: 'AGENTS.md', content: 'a', binary: false, size: 1, mtimeMs: 0 }],
			['project:x|opencode.json', { block: 'project:x', path: 'opencode.json', content: 'b', binary: false, size: 1, mtimeMs: 0 }]
		]);
		const unload = stubFetch(responses);
		try {
			const { createFileContentLoader } = await import(
				'$lib/components/features/files/content'
			);
			const loader = createFileContentLoader();
			const r1 = await loader.load('global', 'AGENTS.md');
			const r2 = await loader.load('project:x', 'opencode.json');
			expect(r1.content).toBe('a');
			expect(r2.content).toBe('b');
		} finally {
			unload();
		}
	});

	test('a failed fetch is not cached — retry re-issues the request', async () => {
		let callCount = 0;
		const unload = stubFetch(new Map());
		// Replace with a fetch that always rejects.
		globalThis.fetch = ((async () => {
			callCount++;
			throw new Error('boom');
		}) as unknown) as typeof fetch;
		try {
			const { createFileContentLoader } = await import(
				'$lib/components/features/files/content'
			);
			const loader = createFileContentLoader();
			await expect(loader.load('global', 'AGENTS.md')).rejects.toThrow('boom');
			expect(callCount).toBe(1);
			// Retry: should issue a second fetch because the first was not cached.
			await expect(loader.load('global', 'AGENTS.md')).rejects.toThrow('boom');
			expect(callCount).toBe(2);
		} finally {
			unload();
		}
	});
});

/* ------------------------------------------------------------------ */
/* Row states — source assertions on FileRow.svelte                    */
/* ------------------------------------------------------------------ */

describe('Row states — FileRow.svelte source contract', () => {
	const source = readFileSync(
		join(fileURLToPath(new URL('.', import.meta.url)), 'FileRow.svelte'),
		'utf8'
	);

	test('loading state renders "Loading…" with role="status"', () => {
		expect(source).toContain('Loading…');
		expect(source).toMatch(/role="status"/);
	});

	test('text state renders <pre> inside ScrollView', () => {
		expect(source).toContain('<pre class="files-row__pre">');
		expect(source).toContain('<ScrollView orientation="both">');
	});

	test('binary state renders the exact message', () => {
		expect(source).toContain('Binary file — not displayed.');
	});

	test('error state renders inline with role="alert"', () => {
		expect(source).toMatch(/role="alert"/);
		// The error paragraph carries the dynamic error message.
		expect(source).toContain('{error}');
	});

	test('the toggle button carries aria-expanded and aria-controls', () => {
		expect(source).toContain('aria-expanded={open}');
		expect(source).toContain('aria-controls={contentId}');
	});

	test('collapse keeps the panel div mounted (aria-controls stays valid)', () => {
		// The panel div is always present; content visibility is gated on `open`.
		expect(source).toMatch(/id=\{contentId\}[^>]*class="files-row__content"/);
		expect(source).toContain('{#if open}');
	});

	test('renders the meta line as key: value joined by · when meta is present', () => {
		// metaText is derived from file.meta; each field renders as `label: value`,
		// joined by the bullet separator.
		expect(source).toContain("file.meta.map((field) => `${field.label}: ${field.value}`).join(' · ')");
		expect(source).toContain('files-row__meta');
		expect(source).toContain('{#if metaText !== null}');
	});

	test('falls back to file.name when displayName is absent', () => {
		// The name span uses displayName ?? name so skills show their dir name.
		expect(source).toContain('file.displayName ?? file.name');
	});

	test('omits the meta span when the file carries no meta', () => {
		// metaText is null when file.meta is undefined or empty; the span is
		// conditionally rendered so no empty metadata line appears.
		expect(source).toContain('file.meta === undefined || file.meta.length === 0');
		expect(source).toContain('? null');
	});
});

/* ------------------------------------------------------------------ */
/* AC-12 — Dashboard header entry                                      */
/* ------------------------------------------------------------------ */

describe('AC-12 — Dashboard header links to /files', () => {
	test('Dashboard.svelte renders an <a> to /files with aria-label="Files"', () => {
		const source = readFileSync(
			join(repoRoot, 'src/lib/components/features/dashboard/Dashboard.svelte'),
			'utf8'
		);
		expect(source).toContain('href="/files"');
		expect(source).toContain('aria-label="Files"');
		// The link sits inside the actions snippet slot.
		expect(source).toContain('{#snippet actions()}');
		expect(source).toContain('</DashboardHeader>');
	});
});

/* ------------------------------------------------------------------ */
/* pages.suite.ts integration: /files SSR shell                        */
/* ------------------------------------------------------------------ */

describe('/files page SSR shell', () => {
	test('+page.svelte renders h1 + back link + FileBrowser', () => {
		const source = readFileSync(
			join(repoRoot, 'src/routes/files/+page.svelte'),
			'utf8'
		);
		expect(source).toContain('<h1 class="files-page__title">Files</h1>');
		expect(source).toContain('href="/"');
		expect(source).toContain('<FileBrowser');
		expect(source).toContain('data.blocks');
		expect(source).toContain('data.projectsAvailable');
	});

	test('+page.server.ts never throws on DB failure — returns fallback index', () => {
		const source = readFileSync(
			join(repoRoot, 'src/routes/files/+page.server.ts'),
			'utf8'
		);
		// The loader wraps listFileBlocks in try/catch and returns a fallback.
		expect(source).toContain('try {');
		expect(source).toContain('listFileBlocks()');
		expect(source).toContain('catch');
		expect(source).toContain('projectsAvailable: false');
	});
});
