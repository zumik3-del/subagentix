/**
 * `/files` DTOs and pure helpers (epic #775, spec T1).
 *
 * Client-safe: no server-only, DB, filesystem or DOM imports. Both the server
 * discovery service and the browser UI import these types/patterns, so the
 * allowlist, group order, block-id grammar and binary detection have one home.
 */

import type { AgentFrontmatter } from './agent';

export type FileGroupKind =
	| 'agent'
	| 'subagents'
	| 'skills'
	| 'config'
	| 'references'
	| 'templates';

export type FileBlockScope = 'global' | 'project';

/** One inline `label: value` metadata pair shown next to a file name. */
export interface FileMetaField {
	label: string;
	value: string;
}

/** One allowlisted file, relative to its block root (POSIX, no leading `./`). */
export interface FileRef {
	path: string;
	name: string;
	group: FileGroupKind;
	size: number;
	mtimeMs: number;
	/** Display label overriding `name` (e.g. a skill's directory name). */
	displayName?: string;
	/** Inline frontmatter metadata, already in display order (subagent files). */
	meta?: FileMetaField[];
}

export interface FileGroup {
	kind: FileGroupKind;
	label: string;
	files: FileRef[];
}

export interface FileBlock {
	id: string;
	scope: FileBlockScope;
	name: string;
	worktree: string;
	available: boolean;
	groups: FileGroup[];
}

export interface FileIndex {
	blocks: FileBlock[];
	projectsAvailable: boolean;
}

export interface FileContent {
	block: string;
	path: string;
	content: string | null;
	binary: boolean;
	size: number;
	mtimeMs: number;
}

/** Fixed group emission order; a group with no files is omitted. */
export const FILE_GROUP_ORDER: readonly FileGroupKind[] = [
	'agent',
	'subagents',
	'skills',
	'config',
	'references',
	'templates'
];

export const GROUP_LABELS: Record<FileGroupKind, string> = {
	agent: 'Agent file',
	subagents: 'Subagents',
	skills: 'Skills',
	config: 'Config',
	references: 'References',
	templates: 'Templates'
};

export const GLOBAL_BLOCK_ID = 'global';
export const PROJECT_BLOCK_PREFIX = 'project:';

/** Content cap (512 KiB) and per-group entry cap. */
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_ENTRIES_PER_GROUP = 500;

export type ParsedBlockId =
	| { scope: 'global'; projectId: null }
	| { scope: 'project'; projectId: string };

/** Encode a block id; `global` or `project:<projectId>`. */
export function blockId(scope: FileBlockScope, projectId: string | null = null): string {
	return scope === 'global' ? GLOBAL_BLOCK_ID : `${PROJECT_BLOCK_PREFIX}${projectId ?? ''}`;
}

/** Decode a block id, or `null` when it does not match the grammar. */
export function parseBlockId(id: string): ParsedBlockId | null {
	if (id === GLOBAL_BLOCK_ID) return { scope: 'global', projectId: null };
	if (id.startsWith(PROJECT_BLOCK_PREFIX)) {
		const projectId = id.slice(PROJECT_BLOCK_PREFIX.length);
		if (projectId !== '') return { scope: 'project', projectId };
	}
	return null;
}

/** Inline metadata keys shown for a subagent file, in display order. */
const SUBAGENT_META_ORDER = ['mode', 'temperature', 'steps', 'color', 'model'] as const;

/**
 * Inline metadata for a subagent file: the present frontmatter fields from
 * `mode, temperature, steps, color, model`, in that order, with raw values.
 * Absent (or blank) keys are omitted.
 */
export function subagentMetaFields(frontmatter: AgentFrontmatter): FileMetaField[] {
	const fields: FileMetaField[] = [];
	for (const key of SUBAGENT_META_ORDER) {
		const value = frontmatter[key];
		if (value !== null && value !== '') fields.push({ label: key, value });
	}
	return fields;
}

function isGlobalRel(rel: string): boolean {
	if (rel === 'AGENTS.md') return true;
	if (rel === 'opencode.json' || rel === 'opencode.jsonc') return true;
	return (
		/^(agents|agent)\/[^/]+\.md$/.test(rel) ||
		/^(skills|skill)\/[^/]+\/SKILL\.md$/.test(rel) ||
		/^references\/[^/]+\.md$/.test(rel) ||
		/^templates\/[^/]+\.md$/.test(rel)
	);
}

function isProjectRel(rel: string): boolean {
	if (rel === 'AGENTS.md') return true;
	if (rel === 'opencode.json' || rel === 'opencode.jsonc') return true;
	if (rel === '.opencode/opencode.json' || rel === '.opencode/opencode.jsonc') return true;
	return (
		/^\.opencode\/(agents|agent)\/[^/]+\.md$/.test(rel) ||
		/^\.opencode\/(skills|skill)\/[^/]+\/SKILL\.md$/.test(rel)
	);
}

/**
 * Pattern allowlist for a block-relative path. Rejects empty, absolute, NUL,
 * backslash, any `.`/`..`/empty segment (so `..` traversal and `./`/`//` are
 * refused) and anything outside the §4.1/§4.2 shapes. Pure and locale-free.
 */
export function isAllowedRelPath(scope: FileBlockScope, rel: string): boolean {
	if (typeof rel !== 'string' || rel === '') return false;
	if (rel.includes('\0') || rel.includes('\\')) return false;
	if (rel.startsWith('/') || rel.endsWith('/')) return false;
	const segments = rel.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
	if (scope === 'global') return isGlobalRel(rel);
	if (scope === 'project') return isProjectRel(rel);
	return false;
}

/** Fixed-order, non-empty groups only. */
export function orderGroups(groups: readonly FileGroup[]): FileGroup[] {
	const byKind = new Map<FileGroupKind, FileGroup>();
	for (const group of groups) {
		if (!byKind.has(group.kind)) byKind.set(group.kind, group);
	}
	return FILE_GROUP_ORDER.map((kind) => byKind.get(kind)).filter(
		(group): group is FileGroup => group !== undefined && group.files.length > 0
	);
}

/**
 * True when the bytes are not displayable UTF-8 text: a NUL byte, or a body
 * that the strict UTF-8 decoder rejects. Pure (uses the global `TextDecoder`).
 */
export function detectBinary(bytes: Uint8Array): boolean {
	if (bytes.includes(0)) return true;
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return false;
	} catch {
		return true;
	}
}
