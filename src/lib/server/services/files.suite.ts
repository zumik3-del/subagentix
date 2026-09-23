/**
 * Files service unit + integration suite (epic #775, task #780).
 *
 * Covers AC-1 … AC-10 for the model + service layer. Uses throwaway temp-dir
 * fixtures and a real fixture SQLite DB; the live opencode DB is never touched.
 *
 * Runs in an isolated child `bun test` process (see `files.test.ts` wrapper)
 * to avoid `mock.module('$lib/server/db')` leakage from other test files.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
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

function tempDir(prefix = 'subagentix-files-'): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	mock.restore();
});

/** Build a minimal opencode-shaped fixture DB with a `project` table. */
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
		CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT);
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

/**
 * Build a global config-root fixture with the files described in spec §4.1.
 * Returns the root path.
 */
function buildGlobalFixture(dir: string): string {
	const root = join(dir, 'global-config');
	mkdirSync(root, { recursive: true });
	// agent
	writeFileSync(join(root, 'AGENTS.md'), '# Global AGENTS\n');
	// subagents — both current and legacy, with overlapping basenames
	mkdirSync(join(root, 'agents'), { recursive: true });
	writeFileSync(
		join(root, 'agents', 'developer.md'),
		'---\nmode: subagent\ntemperature: 0.2\nsteps: 100\ncolor: accent\nmodel: claude-sonnet-4-20250514\n---\ndeveloper\n'
	);
	writeFileSync(join(root, 'agents', 'tester.md'), 'tester\n');
	mkdirSync(join(root, 'agent'), { recursive: true });
	writeFileSync(join(root, 'agent', 'developer.md'), 'legacy developer\n'); // same basename -> deduped
	writeFileSync(join(root, 'agent', 'old-skills.md'), 'old\n');
	// skills — current and legacy
	mkdirSync(join(root, 'skills', 'code-review'), { recursive: true });
	writeFileSync(join(root, 'skills', 'code-review', 'SKILL.md'), 'code review\n');
	mkdirSync(join(root, 'skill', 'legacy-tool'), { recursive: true });
	writeFileSync(join(root, 'skill', 'legacy-tool', 'SKILL.md'), 'legacy tool\n');
	// skill dir without SKILL.md -> must be omitted
	mkdirSync(join(root, 'skills', 'empty-skill'), { recursive: true });
	writeFileSync(join(root, 'skills', 'empty-skill', 'README.md'), 'no skill\n');
	// config
	writeFileSync(join(root, 'opencode.json'), '{}\n');
	writeFileSync(join(root, 'opencode.jsonc'), '// c\n');
	// references / templates
	mkdirSync(join(root, 'references'), { recursive: true });
	writeFileSync(join(root, 'references', 'definition-of-done.md'), 'dod\n');
	mkdirSync(join(root, 'templates'), { recursive: true });
	writeFileSync(join(root, 'templates', 'task.md'), 'task\n');
	return root;
}

/**
 * Build a project worktree fixture per spec §4.2.
 * Returns the worktree path.
 */
function buildProjectFixture(dir: string): string {
	const root = join(dir, 'project-worktree');
	mkdirSync(root, { recursive: true });
	// agent
	writeFileSync(join(root, 'AGENTS.md'), '# Project AGENTS\n');
	// subagents
	mkdirSync(join(root, '.opencode', 'agents'), { recursive: true });
	writeFileSync(join(root, '.opencode', 'agents', 'reviewer.md'), 'reviewer\n');
	mkdirSync(join(root, '.opencode', 'agent'), { recursive: true });
	writeFileSync(join(root, '.opencode', 'agent', 'reviewer.md'), 'legacy reviewer\n'); // deduped
	// skills
	mkdirSync(join(root, '.opencode', 'skills', 'formatter'), { recursive: true });
	writeFileSync(join(root, '.opencode', 'skills', 'formatter', 'SKILL.md'), 'fmt\n');
	// config
	writeFileSync(join(root, 'opencode.json'), '{}\n');
	writeFileSync(join(root, '.opencode', 'opencode.json'), '{}}\n');
	return root;
}

/* ------------------------------------------------------------------ */
/* Import helpers                                                     */
/* ------------------------------------------------------------------ */

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

/**
 * Cache-busted absolute specifier so each call gets a fresh module instance.
 * Bun caches modules by resolved path; a unique query string forces a reload.
 */
let bust = 0;
function absSpec(relative: string): string {
	return `${spec(relative)}?bust=${crypto.randomUUID()}-${++bust}`;
}

/* ------------------------------------------------------------------ */
/* AC-1: project source + projectsAvailable                           */
/* ------------------------------------------------------------------ */

describe('AC-1: listFileBlocks project source', () => {
	test('with a live DB returns global + project blocks and projectsAvailable:true', async () => {
		const dir = tempDir('ac1-live-');
		const globalRoot = buildGlobalFixture(dir);
		const projectRoot = buildProjectFixture(dir);
		const dbPath = buildFixtureDb(dir, [
			{ id: 'proj-a', worktree: projectRoot, name: 'Proj A' }
		]);

		process.env.OPENCODE_CONFIG_DIR = globalRoot;
		process.env.OPENCODE_DB = dbPath;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();

		expect(result.projectsAvailable).toBe(true);
		const ids = result.blocks.map((b: { id: string }) => b.id);
		expect(ids).toContain('global');
		expect(ids).toContain('project:proj-a');
		expect(result.blocks).toHaveLength(2);
	});

	test('without a DB (missing OPENCODE_DB) returns global only, projectsAvailable:false', async () => {
		const dir = tempDir('ac1-missing-db-');
		const globalRoot = buildGlobalFixture(dir);
		const missingDb = join(dir, 'missing.db');

		process.env.OPENCODE_CONFIG_DIR = globalRoot;
		process.env.OPENCODE_DB = missingDb;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();

		expect(result.projectsAvailable).toBe(false);
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0].id).toBe('global');
	});

	test('excludes the global pseudo-project (id=global / worktree=/) from blocks', async () => {
		const dir = tempDir('ac1-exclude-global-');
		const globalRoot = buildGlobalFixture(dir);
		const dbPath = buildFixtureDb(dir, [
			{ id: 'global', worktree: '/', name: 'Global Pseudo' },
			{ id: 'proj-a', worktree: join(dir, 'proj-a'), name: 'Proj A' }
		]);

		process.env.OPENCODE_CONFIG_DIR = globalRoot;
		process.env.OPENCODE_DB = dbPath;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();

		const ids = result.blocks.map((b: { id: string }) => b.id);
		expect(ids).not.toContain('project:global');
		expect(ids).not.toContain('project:/');
		expect(ids).toContain('project:proj-a');
	});
});

/* ------------------------------------------------------------------ */
/* AC-2: global discovery                                             */
/* ------------------------------------------------------------------ */

describe('AC-2: global discovery', () => {
	test('discovers all six group kinds in spec order with expected files', async () => {
		const dir = tempDir('ac2-global-');
		const root = buildGlobalFixture(dir);

		process.env.OPENCODE_CONFIG_DIR = root;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
		delete process.env.OPENCODE_DB;

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();

		const globalBlock = result.blocks.find((b: { id: string }) => b.id === 'global')!;
		expect(globalBlock.available).toBe(true);

		const kinds = globalBlock.groups.map((g: { kind: string }) => g.kind);
		expect(kinds).toEqual(['agent', 'subagents', 'skills', 'config', 'references', 'templates']);

		// agent: exactly AGENTS.md
		const agentGroup = globalBlock.groups.find((g: { kind: string }) => g.kind === 'agent')!;
		expect(agentGroup.files).toHaveLength(1);
		expect(agentGroup.files[0].path).toBe('AGENTS.md');

		// subagents: developer (from agents/) + tester + old-skills (from agent/); developer deduped
		const subGroup = globalBlock.groups.find((g: { kind: string }) => g.kind === 'subagents')!;
		const subNames = subGroup.files.map((f: { name: string }) => f.name).sort();
		expect(subNames).toEqual(['developer.md', 'old-skills.md', 'tester.md']);
		const developerRef = subGroup.files.find((f: { name: string }) => f.name === 'developer.md')!;
		expect(developerRef.path).toBe('agents/developer.md');

		// skills: code-review + legacy-tool (empty-skill has no SKILL.md -> omitted)
		const skillGroup = globalBlock.groups.find((g: { kind: string }) => g.kind === 'skills')!;
		expect(skillGroup.files).toHaveLength(2);
		const skillPaths = skillGroup.files.map((f: { path: string }) => f.path);
		expect(skillPaths).toContain('skills/code-review/SKILL.md');
		expect(skillPaths).toContain('skill/legacy-tool/SKILL.md');

		// config: opencode.json then opencode.jsonc
		const cfgGroup = globalBlock.groups.find((g: { kind: string }) => g.kind === 'config')!;
		expect(cfgGroup.files.map((f: { path: string }) => f.path)).toEqual([
			'opencode.json',
			'opencode.jsonc'
		]);

		// references / templates
		const refGroup = globalBlock.groups.find((g: { kind: string }) => g.kind === 'references')!;
		expect(refGroup.files.map((f: { path: string }) => f.path)).toEqual(['references/definition-of-done.md']);
		const tplGroup = globalBlock.groups.find((g: { kind: string }) => g.kind === 'templates')!;
		expect(tplGroup.files.map((f: { path: string }) => f.path)).toEqual(['templates/task.md']);
	});

	test('missing global config root yields available:false with no groups', async () => {
		const dir = tempDir('ac2-missing-root-');
		const fakeRoot = join(dir, 'does-not-exist');

		process.env.OPENCODE_CONFIG_DIR = fakeRoot;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
		delete process.env.OPENCODE_DB;

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();

		const globalBlock = result.blocks.find((b: { id: string }) => b.id === 'global')!;
		expect(globalBlock.available).toBe(false);
		expect(globalBlock.groups).toHaveLength(0);
	});
});

/* ------------------------------------------------------------------ */
/* AC-3: project discovery                                            */
/* ------------------------------------------------------------------ */

describe('AC-3: project discovery', () => {
	test('discovers agent, subagents, skills, config (no references/templates) in spec order', async () => {
		const dir = tempDir('ac3-project-');
		const globalRoot = buildGlobalFixture(dir);
		const projectRoot = buildProjectFixture(dir);
		const dbPath = buildFixtureDb(dir, [
			{ id: 'proj-x', worktree: projectRoot, name: 'Proj X' }
		]);

		process.env.OPENCODE_CONFIG_DIR = globalRoot;
		process.env.OPENCODE_DB = dbPath;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();

		const projBlock = result.blocks.find((b: { id: string }) => b.id === 'project:proj-x')!;
		expect(projBlock.available).toBe(true);

		const kinds = projBlock.groups.map((g: { kind: string }) => g.kind);
		expect(kinds).toEqual(['agent', 'subagents', 'skills', 'config']);

		const agent = projBlock.groups.find((g: { kind: string }) => g.kind === 'agent')!;
		expect(agent.files).toHaveLength(1);
		expect(agent.files[0].path).toBe('AGENTS.md');

		const subs = projBlock.groups.find((g: { kind: string }) => g.kind === 'subagents')!;
		expect(subs.files).toHaveLength(1);
		expect(subs.files[0].path).toBe('.opencode/agents/reviewer.md');

		const skills = projBlock.groups.find((g: { kind: string }) => g.kind === 'skills')!;
		expect(skills.files).toHaveLength(1);
		expect(skills.files[0].path).toBe('.opencode/skills/formatter/SKILL.md');

		const cfg = projBlock.groups.find((g: { kind: string }) => g.kind === 'config')!;
		expect(cfg.files.map((f: { path: string }) => f.path)).toEqual([
			'opencode.json',
			'.opencode/opencode.json'
		]);
	});

	test('missing project worktree yields available:false', async () => {
		const dir = tempDir('ac3-missing-worktree-');
		const globalRoot = buildGlobalFixture(dir);
		const dbPath = buildFixtureDb(dir, [
			{ id: 'proj-lost', worktree: join(dir, 'lost-worktree'), name: 'Lost' }
		]);

		process.env.OPENCODE_CONFIG_DIR = globalRoot;
		process.env.OPENCODE_DB = dbPath;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();

		const lost = result.blocks.find((b: { id: string }) => b.id === 'project:proj-lost')!;
		expect(lost.available).toBe(false);
		expect(lost.groups).toHaveLength(0);
	});
});

/* ------------------------------------------------------------------ */
/* AC-4: ordering / dedupe                                            */
/* ------------------------------------------------------------------ */

describe('AC-4: ordering and dedupe', () => {
	test('same basename in agents/ and agent/ emits exactly one row from agents/', async () => {
		const dir = tempDir('ac4-dedupe-');
		const root = buildGlobalFixture(dir);

		process.env.OPENCODE_CONFIG_DIR = root;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
		delete process.env.OPENCODE_DB;

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();
		const globalBlock = result.blocks.find((b: { id: string }) => b.id === 'global')!;
		const subs = globalBlock.groups.find((g: { kind: string }) => g.kind === 'subagents')!;

		const devs = subs.files.filter((f: { name: string }) => f.name === 'developer.md');
		expect(devs).toHaveLength(1);
		expect(devs[0].path).toBe('agents/developer.md');
	});

	test('skills sorted by directory name ascending', async () => {
		const dir = tempDir('ac4-skill-sort-');
		const root = join(dir, 'global-config');
		mkdirSync(root, { recursive: true });
		for (const name of ['charlie', 'alpha', 'bravo']) {
			mkdirSync(join(root, 'skills', name), { recursive: true });
			writeFileSync(join(root, 'skills', name, 'SKILL.md'), name);
		}

		process.env.OPENCODE_CONFIG_DIR = root;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
		delete process.env.OPENCODE_DB;

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();
		const globalBlock = result.blocks.find((b: { id: string }) => b.id === 'global')!;
		const skills = globalBlock.groups.find((g: { kind: string }) => g.kind === 'skills')!;

		expect(skills.files).toHaveLength(3);
		const paths = skills.files.map((f: { path: string }) => f.path);
		expect(paths).toEqual([
			'skills/alpha/SKILL.md',
			'skills/bravo/SKILL.md',
			'skills/charlie/SKILL.md'
		]);
	});

	test('config emitted in fixed candidate order: json before jsonc', async () => {
		const dir = tempDir('ac4-config-order-');
		const root = join(dir, 'global-config');
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, 'opencode.jsonc'), 'c\n');
		writeFileSync(join(root, 'opencode.json'), '{}\n');

		process.env.OPENCODE_CONFIG_DIR = root;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
		delete process.env.OPENCODE_DB;

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();
		const globalBlock = result.blocks.find((b: { id: string }) => b.id === 'global')!;
		const cfg = globalBlock.groups.find((g: { kind: string }) => g.kind === 'config')!;

		expect(cfg.files.map((f: { path: string }) => f.path)).toEqual(['opencode.json', 'opencode.jsonc']);
	});
});

/* ------------------------------------------------------------------ */
/* AC-sub: subagent meta + skill displayName                          */
/* ------------------------------------------------------------------ */

describe('subagent inline meta + skill displayName', () => {
	test('subagent ref carries meta in mode·temperature·steps·color·model order', async () => {
		const dir = tempDir('meta-sub-');
		const root = buildGlobalFixture(dir);

		process.env.OPENCODE_CONFIG_DIR = root;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
		delete process.env.OPENCODE_DB;

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();

		const globalBlock = result.blocks.find((b: { id: string }) => b.id === 'global')!;
		const subGroup = globalBlock.groups.find((g: { kind: string }) => g.kind === 'subagents')!;
		const developer = subGroup.files.find((f: { name: string }) => f.name === 'developer.md')!;

		expect(developer.meta).toBeDefined();
		expect(developer.meta).toHaveLength(5);
		expect(developer.meta!.map((f: { label: string; value: string }) => f.label)).toEqual([
			'mode',
			'temperature',
			'steps',
			'color',
			'model'
		]);
		expect(developer.meta!.map((f: { label: string; value: string }) => f.value)).toEqual([
			'subagent',
			'0.2',
			'100',
			'accent',
			'claude-sonnet-4-20250514'
		]);
	});

	test('subagent without frontmatter carries no meta', async () => {
		const dir = tempDir('meta-no-fm-');
		const root = buildGlobalFixture(dir);

		process.env.OPENCODE_CONFIG_DIR = root;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
		delete process.env.OPENCODE_DB;

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();

		const globalBlock = result.blocks.find((b: { id: string }) => b.id === 'global')!;
		const subGroup = globalBlock.groups.find((g: { kind: string }) => g.kind === 'subagents')!;
		const tester = subGroup.files.find((f: { name: string }) => f.name === 'tester.md')!;

		expect(tester.meta).toBeUndefined();
	});

	test('skill ref carries displayName = directory name, name/path unchanged', async () => {
		const dir = tempDir('skill-dn-');
		const root = buildGlobalFixture(dir);

		process.env.OPENCODE_CONFIG_DIR = root;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
		delete process.env.OPENCODE_DB;

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();

		const globalBlock = result.blocks.find((b: { id: string }) => b.id === 'global')!;
		const skillGroup = globalBlock.groups.find((g: { kind: string }) => g.kind === 'skills')!;

		const codeReview = skillGroup.files.find((f: { name: string }) => f.name === 'SKILL.md')!;
		expect(codeReview.displayName).toBe('code-review');
		expect(codeReview.name).toBe('SKILL.md');
		expect(codeReview.path).toBe('skills/code-review/SKILL.md');

		const legacyTool = skillGroup.files.find((f: { name: string; path: string }) => f.name === 'SKILL.md' && f.path.includes('legacy'))!;
		expect(legacyTool.displayName).toBe('legacy-tool');
		expect(legacyTool.name).toBe('SKILL.md');
		expect(legacyTool.path).toBe('skill/legacy-tool/SKILL.md');
	});

	test('subagent meta omits absent keys (only present fields emitted)', async () => {
		const dir = tempDir('meta-sparse-');
		const root = join(dir, 'global-config');
		mkdirSync(root, { recursive: true });
		mkdirSync(join(root, 'agents'), { recursive: true });
		// Only mode + steps — no temperature/color/model.
		writeFileSync(
			join(root, 'agents', 'lite.md'),
			'---\nmode: subagent\nsteps: 10\n---\nlite\n'
		);
		// Also write a skill so we can test displayName alongside.
		mkdirSync(join(root, 'skills', 'formatter'), { recursive: true });
		writeFileSync(join(root, 'skills', 'formatter', 'SKILL.md'), 'fmt\n');

		process.env.OPENCODE_CONFIG_DIR = root;
		process.env.SETTINGS_FILE = join(dir, 'settings.json');
		delete process.env.OPENCODE_DB;

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.listFileBlocks();

		const globalBlock = result.blocks.find((b: { id: string }) => b.id === 'global')!;
		const subGroup = globalBlock.groups.find((g: { kind: string }) => g.kind === 'subagents')!;
		const lite = subGroup.files.find((f: { name: string }) => f.name === 'lite.md')!;

		expect(lite.meta).toBeDefined();
		expect(lite.meta).toHaveLength(2);
		expect(lite.meta!.map((f: { label: string }) => f.label)).toEqual(['mode', 'steps']);

		const skillGroup = globalBlock.groups.find((g: { kind: string }) => g.kind === 'skills')!;
		const fmt = skillGroup.files[0];
		expect(fmt.displayName).toBe('formatter');
	});
});

/* ------------------------------------------------------------------ */
/* AC-5 … AC-9: readFileContent                                       */
/* ------------------------------------------------------------------ */

describe('AC-5 … AC-9: readFileContent', () => {
	let globalRoot: string;
	let projectRoot: string;
	let dbPath: string;
	let dir: string;

	beforeEach(async () => {
		dir = tempDir('ac59-');
		globalRoot = buildGlobalFixture(dir);
		projectRoot = buildProjectFixture(dir);
		dbPath = buildFixtureDb(dir, [
			{ id: 'proj-content', worktree: projectRoot, name: 'Content Proj' }
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

	test('AC-5: UTF-8 file returns 200 with content, binary:false', async () => {
		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', 'AGENTS.md');
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('expected ok');
		expect(result.content.binary).toBe(false);
		expect(typeof result.content.content).toBe('string');
		expect(result.content.content).toContain('Global AGENTS');
		expect(result.content.size).toBeGreaterThan(0);
		expect(typeof result.content.mtimeMs).toBe('number');
	});

	test('AC-6: traversal "../x" -> 400 path', async () => {
		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', '../AGENTS.md');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unexpected ok');
		expect(result.status).toBe(400);
		expect(result.field).toBe('path');
	});

	test('AC-6: absolute path -> 400 path', async () => {
		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', '/etc/passwd');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unexpected ok');
		expect(result.status).toBe(400);
		expect(result.field).toBe('path');
	});

	test('AC-6: backslash path -> 400 path', async () => {
		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', 'agents\\developer.md');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unexpected ok');
		expect(result.status).toBe(400);
		expect(result.field).toBe('path');
	});

	test('AC-6: NUL in path -> 400 path', async () => {
		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', 'AGENTS\0.md');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unexpected ok');
		expect(result.status).toBe(400);
		expect(result.field).toBe('path');
	});

	test('AC-6: non-allowlisted filename -> 400 path', async () => {
		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', 'package.json');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unexpected ok');
		expect(result.status).toBe(400);
		expect(result.field).toBe('path');
	});

	test('AC-6: dot-segment traversal -> 400 path', async () => {
		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', 'agents/./../AGENTS.md');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unexpected ok');
		expect(result.status).toBe(400);
		expect(result.field).toBe('path');
	});

	test('AC-7: symlink escaping root -> 400 (containment fail)', async () => {
		const outside = join(dir, 'outside');
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, 'secret.txt'), 'leaked\n');
		const linkPath = join(globalRoot, 'agents', 'leak.md');
		symlinkSync(join(outside, 'secret.txt'), linkPath);

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', 'agents/leak.md');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unexpected ok');
		expect(result.status).toBe(400);
		expect(result.field).toBe('path');

		rmSync(linkPath, { force: true });
	});

	test('AC-7: symlink staying inside root -> 200', async () => {
		const linkPath = join(globalRoot, 'agents', 'linked.md');
		symlinkSync(join(globalRoot, 'AGENTS.md'), linkPath);

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', 'agents/linked.md');
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('expected ok');
		expect(result.content.content).toContain('Global AGENTS');

		rmSync(linkPath, { force: true });
	});

	test('AC-8: file > 512 KiB -> 413 with size and limit', async () => {
		const bigContent = 'x'.repeat(512 * 1024 + 1);
		writeFileSync(join(globalRoot, 'opencode.json'), bigContent);

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', 'opencode.json');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unexpected ok');
		expect(result.status).toBe(413);
		expect(result.size).toBeGreaterThan(512 * 1024);
		expect(result.limit).toBe(512 * 1024);
	});

	test('AC-8: NUL-containing file -> 200 binary:true, content:null', async () => {
		const bytes = new Uint8Array([0x48, 0x00, 0x69]);
		writeFileSync(join(globalRoot, 'AGENTS.md'), bytes);

		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', 'AGENTS.md');
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('expected ok');
		expect(result.content.binary).toBe(true);
		expect(result.content.content).toBeNull();
		expect(result.content.size).toBe(3);
	});

	test('AC-9: unknown block -> 404', async () => {
		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('project:nonexistent', 'AGENTS.md');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unexpected ok');
		expect(result.status).toBe(404);
	});

	test('AC-9: missing allowlisted file -> 404', async () => {
		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('global', 'references/nonexistent.md');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unexpected ok');
		expect(result.status).toBe(404);
	});

	test('AC-9: malformed block id (empty project:) -> 400', async () => {
		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		const result = mod.readFileContent('project:', 'AGENTS.md');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('unexpected ok');
		expect(result.status).toBe(400);
		expect(result.field).toBe('block');
	});

	test('AC-9: blank block or path -> 400', async () => {
		const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
		expect(mod.readFileContent('', 'AGENTS.md').ok).toBe(false);
		expect(mod.readFileContent('   ', 'AGENTS.md').ok).toBe(false);
		expect(mod.readFileContent('global', '').ok).toBe(false);
		expect(mod.readFileContent('global', '   ').ok).toBe(false);
	});

	test('AC-9: EACCES on unreadable file -> 403', async () => {
		const target = join(globalRoot, 'opencode.json');
		const original = readFileSync(target);
		chmodSync(target, 0o000);
		try {
			const mod = (await import(absSpec('../../server/services/files.ts'))) as typeof import('../../server/services/files.ts');
			const result = mod.readFileContent('global', 'opencode.json');
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error('unexpected ok');
			expect(result.status).toBe(403);
		} finally {
			chmodSync(target, 0o644);
			writeFileSync(target, original);
		}
	});
});

/* ------------------------------------------------------------------ */
/* AC-10: no credential references                                    */
/* ------------------------------------------------------------------ */

describe('AC-10: no credential / DB-table leak', () => {
	test('files-content.ts never references ~/.local/share/opencode paths', () => {
		const src = readFileSync(spec('../../server/services/files-content.ts'), 'utf8');
		expect(src).not.toContain('~/.local/share/opencode');
		expect(src).not.toContain('auth.json');
		expect(src).not.toContain('account.json');
		expect(src).not.toContain('mcp-auth.json');
	});

	test('files-content.ts does not import account or credential tables', () => {
		const src = readFileSync(spec('../../server/services/files-content.ts'), 'utf8');
		expect(src.toLowerCase()).not.toContain('account');
		expect(src.toLowerCase()).not.toContain('credential');
	});

	test('projects.ts query selects only id, worktree, name', () => {
		const src = readFileSync(spec('../../server/queries/projects.ts'), 'utf8');
		expect(src).toContain("SELECT id, worktree, name FROM project");
		// Verify no other columns besides id, worktree, name appear in any
		// SELECT...FROM project line (listProjectRows + findProjectRow each have one).
		const lines = src
			.split('\n')
			.filter((l) => /SELECT\s+.*\s+FROM\s+project\b/i.test(l));
		expect(lines.length).toBe(2);
		for (const line of lines) {
			const cols = line.match(/SELECT\s+(.+?)\s+FROM\s+project\b/i);
			expect(cols).not.toBeNull();
			const selected = (cols![1] as string)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			for (const col of selected) {
				expect(['id', 'worktree', 'name']).toContain(col);
			}
		}
	});

	test('model files.ts has no $lib/server imports', () => {
		const src = readFileSync(spec('../../model/files.ts'), 'utf8');
		expect(src).not.toContain('$lib/server');
	});
});
