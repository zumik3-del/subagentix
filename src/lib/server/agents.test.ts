import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverAgentDirs, listAgents } from './agents';

/**
 * Unit tests for the server-side subagents reader (settings subagents tab).
 *
 * Each scenario isolates `SETTINGS_FILE` and `OPENCODE_CONFIG_DIR` so the
 * process-global settings cache and the host's real agent directory cannot
 * leak in. A missing directory must degrade to `[]` without throwing.
 */

const tempDirs: string[] = [];
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalSettingsFile = process.env.SETTINGS_FILE;
const originalAgentsEnv = process.env.OPENCODE_AGENTS_DIR;

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeAgent(dir: string, name: string, content: string): void {
	writeFileSync(join(dir, `${name}.md`), content, 'utf8');
}

function seedSetting(agentsPath: string): void {
	const file = process.env.SETTINGS_FILE as string;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ version: 1, agentsPath }), 'utf8');
}

beforeEach(() => {
	process.env.SETTINGS_FILE = join(
		tempDir('subagentix-agents-settings-'),
		'settings.json'
	);
	process.env.OPENCODE_CONFIG_DIR = tempDir('subagentix-agents-config-');
	delete process.env.OPENCODE_AGENTS_DIR;
});

afterEach(() => {
	if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
	else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
	if (originalSettingsFile === undefined) delete process.env.SETTINGS_FILE;
	else process.env.SETTINGS_FILE = originalSettingsFile;
	if (originalAgentsEnv === undefined) delete process.env.OPENCODE_AGENTS_DIR;
	else process.env.OPENCODE_AGENTS_DIR = originalAgentsEnv;
});

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('listAgents', () => {
	test('parses name, description, model, mode, color and temperature', () => {
		const dir = tempDir('subagentix-agents-parse-');
		writeAgent(
			dir,
			'developer',
			'---\ndescription: Build things.\nmode: subagent\ncolor: accent\nmodel: opencode-go/x # note\ntemperature: 0.2\n---\nbody\n'
		);

		const { agents } = listAgents(dir);
		expect(agents).toHaveLength(1);
		expect(agents[0]).toMatchObject({
			name: 'developer',
			file: 'developer.md',
			description: 'Build things.',
			mode: 'subagent',
			color: 'accent',
			colorVar: 'var(--color-accent-base)',
			model: 'opencode-go/x',
			temperature: '0.2'
		});
	});

	test('skips non-md files and missing dirs; md without frontmatter has null fields', () => {
		const dir = tempDir('subagentix-agents-skip-');
		writeFileSync(join(dir, 'notes.txt'), 'ignore me', 'utf8');
		writeAgent(dir, 'plain', 'no frontmatter here\n');
		writeAgent(dir, 'valid', '---\ncolor: success\n---\n');

		const { agents } = listAgents(dir);
		expect(agents.map((a) => a.name)).toEqual(['plain', 'valid']);
		expect(agents[0]).toMatchObject({ name: 'plain', description: null, color: null, colorVar: null });
		expect(listAgents(join(dir, 'missing')).agents).toEqual([]);
	});

	test('falls back to OPENCODE_CONFIG_DIR agents/ when no setting is stored', () => {
		const root = process.env.OPENCODE_CONFIG_DIR as string;
		mkdirSync(join(root, 'agents'), { recursive: true });
		writeAgent(join(root, 'agents'), 'tester', '---\ncolor: warning\n---\n');

		const { agents } = listAgents();
		expect(agents.map((a) => a.name)).toEqual(['tester']);
	});

	test('agentsPath setting overrides the default scan', () => {
		const custom = tempDir('subagentix-agents-custom-');
		writeAgent(custom, 'analyst', '---\ncolor: info\n---\n');
		seedSetting(custom);

		const { dir, agents } = listAgents();
		expect(dir).toBe(custom);
		expect(agents.map((a) => a.name)).toEqual(['analyst']);
	});
});

describe('discoverAgentDirs', () => {
	test('finds the config agents directory and recommends it', () => {
		const root = process.env.OPENCODE_CONFIG_DIR as string;
		const agentsDir = join(root, 'agents');
		mkdirSync(agentsDir, { recursive: true });
		writeAgent(agentsDir, 'first', '---\ncolor: primary\n---\n');
		writeAgent(agentsDir, 'second', '---\ncolor: secondary\n---\n');

		const result = discoverAgentDirs();
		expect(result.candidates.some((c) => c.path === agentsDir && c.agentCount === 2)).toBe(true);
		expect(result.recommended).toBe(agentsDir);
	});

	test('skips a config dir that has no md files', () => {
		const root = process.env.OPENCODE_CONFIG_DIR as string;
		const result = discoverAgentDirs();
		expect(result.candidates.some((c) => c.path === join(root, 'agents'))).toBe(false);
		expect(result.candidates.every((c) => c.agentCount > 0)).toBe(true);
	});
});
