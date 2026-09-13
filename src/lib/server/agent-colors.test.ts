import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAgentColors } from './agent-colors';

/**
 * Unit tests for `getAgentColors()` (task #239).
 *
 * The module reads from `${OPENCODE_CONFIG_DIR}/agents/*.md` (and the legacy
 * singular `agent/` dir) so we point it at a temp directory with crafted md
 * files. `cache` is process-global, so each test restores the original env
 * value and clears the cache via module re-import is NOT possible; instead we
 * rely on the fact that the cache key is the resolved dir path, and we use
 * distinct temp dirs per test. To avoid leaking between tests we also restore
 * `OPENCODE_CONFIG_DIR` in `afterEach`.
 */

let origEnv: string | undefined;
let origSettingsFile: string | undefined;
let origAgentsEnv: string | undefined;

beforeEach(() => {
	origEnv = process.env.OPENCODE_CONFIG_DIR;
	origSettingsFile = process.env.SETTINGS_FILE;
	origAgentsEnv = process.env.OPENCODE_AGENTS_DIR;
	// Isolate the settings store so a stored `agentsPath` can never override
	// the temp OPENCODE_CONFIG_DIR under test.
	process.env.SETTINGS_FILE = join(tmpdir(), `subagentix-agent-colors-settings-${crypto.randomUUID()}.json`);
	delete process.env.OPENCODE_AGENTS_DIR;
});

afterEach(() => {
	if (origEnv === undefined) delete process.env.OPENCODE_CONFIG_DIR;
	else process.env.OPENCODE_CONFIG_DIR = origEnv;
	if (origSettingsFile === undefined) delete process.env.SETTINGS_FILE;
	else process.env.SETTINGS_FILE = origSettingsFile;
	if (origAgentsEnv === undefined) delete process.env.OPENCODE_AGENTS_DIR;
	else process.env.OPENCODE_AGENTS_DIR = origAgentsEnv;
});

function mkTempDir(prefix: string): string {
	const dir = join(tmpdir(), prefix);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(dir, 'agents'), { recursive: true });
	return dir;
}

function writeMd(dir: string, name: string, content: string): void {
	writeFileSync(join(dir, `${name}.md`), content, 'utf8');
}

describe('getAgentColors()', () => {
	test('maps agent names to CSS vars from agents/*.md frontmatter', () => {
		const dir = mkTempDir('subagentix-agent-colors-');
		process.env.OPENCODE_CONFIG_DIR = dir;

		writeMd(dir, 'agents/build', '---\ncolor: primary\n---\n');
		writeMd(dir, 'agents/deploy', '---\ncolor: warning\n---\n');
		writeMd(dir, 'agents/orphan', '---\nname: no-color\n---\n'); // no color key

		const colors = getAgentColors();
		expect(colors).toEqual({
			build: 'var(--icon-strong-base)',
			deploy: 'var(--color-warning-base)'
		});
	});

	test('reads legacy singular agent/*.md directory too', () => {
		const dir = mkTempDir('subagentix-agent-colors-legacy-');
		process.env.OPENCODE_CONFIG_DIR = dir;

		// Create the legacy `agent/` dir (singular) alongside the canonical `agents/`.
		const agentDir = join(dir, 'agent');
		const agentsDir = join(dir, 'agents');
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(agentsDir, { recursive: true });

		writeMd(agentDir, 'old-agent', '---\ncolor: accent\n---\n');
		writeMd(agentsDir, 'new-agent', '---\ncolor: success\n---\n');

		const colors = getAgentColors();
		// Legacy dir is read first, then canonical `agents/` overwrites on collision.
		expect(colors).toEqual({
			'old-agent': 'var(--color-accent-base)',
			'new-agent': 'var(--color-success-base)'
		});
	});

	test('canonical agents/ wins over legacy agent/ on name collision', () => {
		const dir = mkTempDir('subagentix-agent-colors-collision-');
		process.env.OPENCODE_CONFIG_DIR = dir;

		const agentDir = join(dir, 'agent');
		const agentsDir = join(dir, 'agents');
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(agentsDir, { recursive: true });

		writeMd(agentDir, 'shared', '---\ncolor: primary\n---\n');
		writeMd(agentsDir, 'shared', '---\ncolor: error\n---\n');

		const colors = getAgentColors();
		expect(colors['shared']).toBe('var(--color-danger-base)');
	});

	test('returns {} when the config dir does not exist', () => {
		const dir = mkTempDir('subagentix-agent-colors-missing-');
		// Do NOT create any subdirs; the dir itself is empty/missing agents/.
		process.env.OPENCODE_CONFIG_DIR = dir;

		expect(getAgentColors()).toEqual({});
	});

	test('returns {} when agents/ is missing but config dir exists', () => {
		const dir = mkTempDir('subagentix-agent-colors-noagents-');
		process.env.OPENCODE_CONFIG_DIR = dir;
		// Dir exists but no agents/ subdir.

		expect(getAgentColors()).toEqual({});
	});

	test('skips files with no frontmatter or no color key', () => {
		const dir = mkTempDir('subagentix-agent-colors-skip-');
		process.env.OPENCODE_CONFIG_DIR = dir;

		writeMd(dir, 'agents/plain', 'just some text\n');
		writeMd(dir, 'agents/no-header', '---\nname: foo\n---\n'); // no color
		writeMd(dir, 'agents/valid', '---\ncolor: info\n---\n');

		const colors = getAgentColors();
		expect(colors).toEqual({ valid: 'var(--color-info-base)' });
	});

	test('is idempotent: second call returns the same cached result', () => {
		const dir = mkTempDir('subagentix-agent-colors-cache-');
		process.env.OPENCODE_CONFIG_DIR = dir;

		writeMd(dir, 'agents/x', '---\ncolor: primary\n---\n');
		const first = getAgentColors();
		const second = getAgentColors();
		expect(second).toBe(first); // same cached object reference
	});

	test('agentsPath setting overrides the default config dir scan', () => {
		const root = mkTempDir('subagentix-agent-colors-override-');
		process.env.OPENCODE_CONFIG_DIR = root;
		// The default scan would find this one.
		writeMd(root, 'agents/default', '---\ncolor: primary\n---\n');

		const custom = mkTempDir('subagentix-agent-colors-custom-');
		const customDir = join(custom, 'agents');
		writeMd(custom, 'agents/custom', '---\ncolor: warning\n---\n');

		const file = process.env.SETTINGS_FILE as string;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ version: 1, agentsPath: customDir }), 'utf8');

		expect(getAgentColors()).toEqual({ custom: 'var(--color-warning-base)' });
	});
});
