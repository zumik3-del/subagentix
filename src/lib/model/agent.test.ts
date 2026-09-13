import { describe, expect, test } from 'bun:test';
import { AGENT_FALLBACK_COLOR, agentColorVar, displayAgent, parseAgentColor } from './agent';

/**
 * Unit tests for the opencode agent-color adapter (task #239).
 *
 * `parseAgentColor` extracts the raw `color:` token from YAML frontmatter;
 * `agentColorVar` resolves that token to a CSS variable reference. Both are
 * pure functions with no DB or filesystem dependencies, so they can be tested
 * directly without fixtures.
 */

describe('parseAgentColor()', () => {
	test('extracts an unquoted token from leading frontmatter', () => {
		const md = `---\nname: build\ncolor: primary\n---\nSome body.`;
		expect(parseAgentColor(md)).toBe('primary');
	});

	test('extracts a double-quoted token', () => {
		const md = '---\ncolor: "accent"\n---\nbody';
		expect(parseAgentColor(md)).toBe('accent');
	});

	test('extracts a single-quoted token', () => {
		const md = "---\ncolor: 'warning'\n---\nbody";
		expect(parseAgentColor(md)).toBe('warning');
	});

	test('strips a BOM prefix before the frontmatter delimiter', () => {
		// U+FEFF BOM precedes the opening `---`.
		const md = '\uFEFF---\ncolor: error\n---\nbody';
		expect(parseAgentColor(md)).toBe('error');
	});

	test('returns null when there is no frontmatter', () => {
		expect(parseAgentColor('just a plain markdown file')).toBeNull();
	});

	test('returns null when frontmatter has no color key', () => {
		const md = '---\nname: build\nlevel: 3\n---\nbody';
		expect(parseAgentColor(md)).toBeNull();
	});

	test('returns null when the color value is blank after trimming', () => {
		const md = '---\ncolor: \n---\nbody';
		expect(parseAgentColor(md)).toBeNull();
	});

	test('ignores a `color:` line in the body (leading frontmatter only)', () => {
		const md = '---\nname: build\n---\n# Header\ncolor: should-not-match';
		expect(parseAgentColor(md)).toBeNull();
	});

	test('handles CRLF line endings in frontmatter', () => {
		const md = '---\r\ncolor: success\r\n---\r\nbody';
		expect(parseAgentColor(md)).toBe('success');
	});
});

describe('AGENT_FALLBACK_COLOR (task #253)', () => {
	test('is a gray token so colorless agents read as neutral, not a model color', () => {
		expect(AGENT_FALLBACK_COLOR).toBe('var(--icon-base)');
	});
});

describe('displayAgent() — main-process orchestrator renamed to "main"', () => {
	test('maps build/plan to "main"', () => {
		expect(displayAgent('build')).toBe('main');
		expect(displayAgent('plan')).toBe('main');
	});

	test('is case- and whitespace-insensitive', () => {
		expect(displayAgent('BUILD')).toBe('main');
		expect(displayAgent('  Plan  ')).toBe('main');
	});

	test('passes every other agent through unchanged', () => {
		expect(displayAgent('developer')).toBe('developer');
		expect(displayAgent('reviewer')).toBe('reviewer');
		expect(displayAgent('tester')).toBe('tester');
	});

	test('falls back to "unknown" for missing names', () => {
		expect(displayAgent(null)).toBe('unknown');
		expect(displayAgent(undefined)).toBe('unknown');
		expect(displayAgent('   ')).toBe('unknown');
	});
});

describe('agentColorVar()', () => {
	test('resolves known tokens to CSS variable references', () => {
		expect(agentColorVar('primary')).toBe('var(--icon-strong-base)');
		expect(agentColorVar('secondary')).toBe('var(--icon-base)');
		expect(agentColorVar('accent')).toBe('var(--color-accent-base)');
		expect(agentColorVar('success')).toBe('var(--color-success-base)');
		expect(agentColorVar('warning')).toBe('var(--color-warning-base)');
		expect(agentColorVar('error')).toBe('var(--color-danger-base)');
		expect(agentColorVar('info')).toBe('var(--color-info-base)');
	});

	test('is case-insensitive', () => {
		expect(agentColorVar('PRIMARY')).toBe('var(--icon-strong-base)');
		expect(agentColorVar('Accent')).toBe('var(--color-accent-base)');
		expect(agentColorVar('SuCcEsS')).toBe('var(--color-success-base)');
	});

	test('trims whitespace around the token', () => {
		expect(agentColorVar('  warning  ')).toBe('var(--color-warning-base)');
		expect(agentColorVar('\terror\t')).toBe('var(--color-danger-base)');
	});

	test('returns null for an unknown token', () => {
		expect(agentColorVar('neon-pink')).toBeNull();
		expect(agentColorVar('custom')).toBeNull();
	});

	test('returns null when the token is missing / null / undefined', () => {
		expect(agentColorVar(null)).toBeNull();
		expect(agentColorVar(undefined)).toBeNull();
		expect(agentColorVar('')).toBeNull();
	});
});
