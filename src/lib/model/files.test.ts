import { describe, expect, test } from 'bun:test';
import { parseAgentFrontmatter, type AgentFrontmatter } from './agent';
import {
	detectBinary,
	FILE_GROUP_ORDER,
	GROUP_LABELS,
	GLOBAL_BLOCK_ID,
	MAX_ENTRIES_PER_GROUP,
	MAX_FILE_BYTES,
	PROJECT_BLOCK_PREFIX,
	blockId,
	isAllowedRelPath,
	orderGroups,
	parseBlockId,
	subagentMetaFields,
	type FileBlock,
	type FileBlockScope,
	type FileGroup,
	type FileGroupKind,
	type FileRef
} from './files';

/**
 * Pure unit tests for the `/files` model (epic #775, task #780).
 *
 * No I/O, no `$lib/server` imports — purely functional.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

describe('constants', () => {
	test('FILE_GROUP_ORDER has exactly 6 entries in spec order', () => {
		expect(FILE_GROUP_ORDER).toEqual([
			'agent',
			'subagents',
			'skills',
			'config',
			'references',
			'templates'
		]);
	});

	test('GROUP_LABELS covers every kind', () => {
		for (const kind of FILE_GROUP_ORDER) {
			expect(typeof GROUP_LABELS[kind]).toBe('string');
			expect(GROUP_LABELS[kind].length).toBeGreaterThan(0);
		}
	});

	test('MAX_FILE_BYTES is 512 KiB', () => {
		expect(MAX_FILE_BYTES).toBe(512 * 1024);
	});

	test('MAX_ENTRIES_PER_GROUP is 500', () => {
		expect(MAX_ENTRIES_PER_GROUP).toBe(500);
	});

	test('block-id constants are well-formed', () => {
		expect(GLOBAL_BLOCK_ID).toBe('global');
		expect(PROJECT_BLOCK_PREFIX).toBe('project:');
	});
});

/* ------------------------------------------------------------------ */
/* blockId / parseBlockId round-trip                                  */
/* ------------------------------------------------------------------ */

describe('blockId / parseBlockId', () => {
	test('global block round-trips', () => {
		const id = blockId('global');
		expect(id).toBe('global');
		expect(parseBlockId(id)).toEqual({ scope: 'global', projectId: null });
	});

	test('project block round-trips', () => {
		const id = blockId('project', 'my-project');
		expect(id).toBe('project:my-project');
		expect(parseBlockId(id)).toEqual({ scope: 'project', projectId: 'my-project' });
	});

	test('project block with empty projectId yields project:', () => {
		const id = blockId('project', '');
		expect(id).toBe('project:');
		expect(parseBlockId(id)).toBeNull(); // empty projectId is malformed
	});

	test('parseBlockId rejects random strings', () => {
		expect(parseBlockId('foobar')).toBeNull();
		expect(parseBlockId('project')).toBeNull();
		expect(parseBlockId(':project')).toBeNull();
		expect(parseBlockId('globalextra')).toBeNull();
	});

	test('parseBlockId accepts project: with non-empty id', () => {
		expect(parseBlockId('project:abc123')).toEqual({
			scope: 'project',
			projectId: 'abc123'
		});
	});
});

/* ------------------------------------------------------------------ */
/* isAllowedRelPath matrix (AC-6, AC-18)                              */
/* ------------------------------------------------------------------ */

describe('isAllowedRelPath', () => {
	const globalAllowed: Array<[string, boolean]> = [
		['AGENTS.md', true],
		['opencode.json', true],
		['opencode.jsonc', true],
		['agents/developer.md', true],
		['agents/tester.md', true],
		['agent/legacy.md', true],
		['skills/some/SKILL.md', true],
		['skill/legacy-skill/SKILL.md', true],
		['references/ui-standards.md', true],
		['templates/task.md', true]
	];

	const projectAllowed: Array<[string, boolean]> = [
		['AGENTS.md', true],
		['opencode.json', true],
		['opencode.jsonc', true],
		['.opencode/opencode.json', true],
		['.opencode/opencode.jsonc', true],
		['.opencode/agents/developer.md', true],
		['.opencode/agent/legacy.md', true],
		['.opencode/skills/some/SKILL.md', true],
		['.opencode/skill/legacy-skill/SKILL.md', true]
	];

	const universalRejected: Array<[string]> = [
		[''], // empty
		['.'],
		['..'],
		['./AGENTS.md'],
		['../AGENTS.md'],
		['../../etc/passwd'],
		['/etc/passwd'], // absolute
		['C:\\windows\\system32'],
		['AGENTS.md\0.bak'], // NUL
		['agents/../hidden.md'],
		['agents//double-slash.md'],
		['skills/s/KILL.md'], // wrong filename
		['templates/'], // trailing slash
	];

	test('global scope: allowlisted paths accepted', () => {
		for (const [rel, expected] of globalAllowed) {
			expect(isAllowedRelPath('global', rel)).toBe(expected);
		}
	});

	test('project scope: allowlisted paths accepted', () => {
		for (const [rel, expected] of projectAllowed) {
			expect(isAllowedRelPath('project', rel)).toBe(expected);
		}
	});

	test('global scope: non-allowlisted project paths rejected', () => {
		// Project-specific paths must NOT pass in global scope.
		expect(isAllowedRelPath('global', '.opencode/agents/developer.md')).toBe(false);
		expect(isAllowedRelPath('global', '.opencode/opencode.json')).toBe(false);
	});

	test('project scope: global references/templates rejected (project-only)', () => {
		// Project blocks do not have references/templates groups.
		expect(isAllowedRelPath('project', 'references/r.md')).toBe(false);
		expect(isAllowedRelPath('project', 'templates/t.md')).toBe(false);
		expect(isAllowedRelPath('project', 'agents/developer.md')).toBe(false);
		expect(isAllowedRelPath('project', 'skills/s/SKILL.md')).toBe(false);
	});

	test('universal rejects: empty, dot, double-dot, absolute, backslash, NUL, traversal', () => {
		for (const [rel] of universalRejected) {
			expect(isAllowedRelPath('global', rel)).toBe(false);
			expect(isAllowedRelPath('project', rel)).toBe(false);
		}
	});

	test('rejects non-string input', () => {
		expect(isAllowedRelPath('global', '' as unknown as string)).toBe(false);
		expect(isAllowedRelPath('global', null as unknown as string)).toBe(false);
		expect(isAllowedRelPath('global', 42 as unknown as string)).toBe(false);
	});

	test('rejects unknown scope', () => {
		expect(isAllowedRelPath('global' as FileBlockScope, 'AGENTS.md')).toBe(true);
		expect(isAllowedRelPath('project' as FileBlockScope, 'AGENTS.md')).toBe(true);
		// Any non-global/non-project scope falls through to false.
		expect(isAllowedRelPath('unknown' as FileBlockScope, 'AGENTS.md')).toBe(false);
	});
});

/* ------------------------------------------------------------------ */
/* orderGroups (AC-4)                                                 */
/* ------------------------------------------------------------------ */

describe('orderGroups', () => {
	function group(kind: FileGroupKind, files: FileRef[] = []): FileGroup {
		return { kind, label: GROUP_LABELS[kind], files };
	}

	function ref(name: string, group: FileGroupKind): FileRef {
		return { path: name, name, group, size: 1, mtimeMs: 0 };
	}

	test('preserves fixed group order', () => {
		const groups = orderGroups([
			group('templates', [ref('t.md', 'templates')]),
			group('agent', [ref('AGENTS.md', 'agent')]),
			group('skills', [ref('s/SKILL.md', 'skills')]),
			group('config', [ref('opencode.json', 'config')]),
			group('subagents', [ref('a.md', 'subagents')]),
			group('references', [ref('r.md', 'references')])
		]);
		expect(groups.map((g) => g.kind)).toEqual([...FILE_GROUP_ORDER]);
	});

	test('omits empty groups', () => {
		const groups = orderGroups([
			group('agent', []),
			group('subagents', [ref('a.md', 'subagents')]),
			group('skills', [])
		]);
		expect(groups.map((g) => g.kind)).toEqual(['subagents']);
	});

	test('dedupes: last occurrence wins (stable — first wins since we only set once)', () => {
		// If two groups of the same kind are passed, the first one wins
		// (the implementation uses `if (!byKind.has(...))`).
		const groups = orderGroups([
			group('agent', [ref('AGENTS.md', 'agent')]),
			group('agent', [ref('OTHER.md', 'agent')])
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].files).toHaveLength(1);
		expect(groups[0].files[0].path).toBe('AGENTS.md');
	});
});

/* ------------------------------------------------------------------ */
/* detectBinary (AC-8)                                                */
/* ------------------------------------------------------------------ */

describe('detectBinary', () => {
	test('empty buffer is not binary', () => {
		expect(detectBinary(new Uint8Array())).toBe(false);
	});

	test('valid ASCII is not binary', () => {
		const bytes = new TextEncoder().encode('hello world');
		expect(detectBinary(bytes)).toBe(false);
	});

	test('valid UTF-8 is not binary', () => {
		const bytes = new TextEncoder().encode('héllo — 世界 🌍');
		expect(detectBinary(bytes)).toBe(false);
	});

	test('a NUL byte makes the buffer binary', () => {
		const bytes = new Uint8Array([0x48, 0x00, 0x4a]); // 'H\x00J'
		expect(detectBinary(bytes)).toBe(true);
	});

	test('invalid UTF-8 sequence is binary', () => {
		// 0xfe is a non-valid UTF-8 lead byte.
		const bytes = new Uint8Array([0xfe, 0xfe]);
		expect(detectBinary(bytes)).toBe(true);
	});

	test('invalid UTF-8 mid-sequence is binary', () => {
		// 0xc0 is an overlong-sequence lead byte — always illegal.
		const bytes = new Uint8Array([0xc0, 0x80]);
		expect(detectBinary(bytes)).toBe(true);
	});

	test('valid multi-byte UTF-8 is not binary', () => {
		const bytes = new TextEncoder().encode('✅🎉🚀');
		expect(detectBinary(bytes)).toBe(false);
	});
});

/* ------------------------------------------------------------------ */
/* parseAgentFrontmatter — steps + existing keys                      */
/* ------------------------------------------------------------------ */

describe('parseAgentFrontmatter', () => {
	test('parses mode, temperature, steps, color, model from YAML frontmatter', () => {
		const md = `---
mode: subagent
temperature: 0.2
steps: 100
color: accent
model: claude-sonnet-4-20250514
---
Body text`;
		const fm = parseAgentFrontmatter(md);
		expect(fm).toEqual({
			name: null,
			description: null,
			model: 'claude-sonnet-4-20250514',
			mode: 'subagent',
			color: 'accent',
			temperature: '0.2',
			steps: '100'
		});
	});

	test('steps is parsed as a string, not coerced to number', () => {
		const md = '---\nsteps: 42\n---\nbody';
		expect(parseAgentFrontmatter(md).steps).toBe('42');
	});

	test('existing keys (name, description) are also parsed', () => {
		const md = '---\nname: tester\ndescription: runs tests\n---\nbody';
		const fm = parseAgentFrontmatter(md);
		expect(fm.name).toBe('tester');
		expect(fm.description).toBe('runs tests');
	});

	test('returns all-null frontmatter when there is no YAML block', () => {
		expect(parseAgentFrontmatter('just body text')).toEqual({
			name: null,
			description: null,
			model: null,
			mode: null,
			color: null,
			temperature: null,
			steps: null
		});
	});

	test('ignores unknown keys', () => {
		const md = '---\nfoo: bar\nmode: subagent\nbaz: qux\n---\nbody';
		const fm = parseAgentFrontmatter(md);
		expect(fm.mode).toBe('subagent');
		// Unknown keys stay null (they are not in the shape).
	});
});

/* ------------------------------------------------------------------ */
/* subagentMetaFields — order + omit                                  */
/* ------------------------------------------------------------------ */

describe('subagentMetaFields', () => {
	function fm(
		overrides: Partial<AgentFrontmatter> = {}
	): AgentFrontmatter {
		return {
			name: null,
			description: null,
			model: null,
			mode: null,
			color: null,
			temperature: null,
			steps: null,
			...overrides
		} as AgentFrontmatter;
	}

	test('emits fields in order mode, temperature, steps, color, model', () => {
		const fields = subagentMetaFields(fm({
			mode: 'subagent',
			temperature: '0.2',
			steps: '100',
			color: 'accent',
			model: 'claude-sonnet'
		}));
		expect(fields.map((f) => f.label)).toEqual([
			'mode',
			'temperature',
			'steps',
			'color',
			'model'
		]);
		expect(fields.map((f) => f.value)).toEqual([
			'subagent',
			'0.2',
			'100',
			'accent',
			'claude-sonnet'
		]);
	});

	test('omits absent (null) keys', () => {
		const fields = subagentMetaFields(fm({ mode: 'subagent', steps: '10' }));
		expect(fields).toEqual([
			{ label: 'mode', value: 'subagent' },
			{ label: 'steps', value: '10' }
		]);
	});

	test('omits blank (empty string) keys', () => {
		const fields = subagentMetaFields(fm({ mode: '', steps: '5' }));
		expect(fields).toEqual([
			{ label: 'steps', value: '5' }
		]);
	});

	test('empty frontmatter yields an empty array', () => {
		expect(subagentMetaFields(fm())).toEqual([]);
	});

	test('only model present', () => {
		const fields = subagentMetaFields(fm({ model: 'gpt-4o' }));
		expect(fields).toEqual([{ label: 'model', value: 'gpt-4o' }]);
	});
});
