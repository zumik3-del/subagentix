/**
 * `/files` service entry (epic #775, spec T1): the block index (the global
 * opencode config plus one block per opencode project) and the on-demand
 * content read. Read-only and bounded; the FS/DB helpers live in
 * `files-discovery.ts` and the content read in `files-content.ts`.
 */
import { join } from 'node:path';
import {
	blockId,
	GROUP_LABELS,
	orderGroups,
	type FileBlock,
	type FileGroup,
	type FileIndex,
	type FileRef
} from '$lib/model/files';
import {
	compareNames,
	configDir,
	fileRef,
	isDirectory,
	mdFilesInDir,
	projectEntries,
	subdirsInDir,
	withSubagentMeta
} from './files-discovery';

export { readFileContent, type FileReadResult } from './files-content';

const GLOBAL_CONFIG_CANDIDATES = ['opencode.json', 'opencode.jsonc'];
const PROJECT_CONFIG_CANDIDATES = [
	'opencode.json',
	'opencode.jsonc',
	'.opencode/opencode.json',
	'.opencode/opencode.jsonc'
];

/** The single root `AGENTS.md` (project agent file is the worktree root). */
function agentGroup(root: string): FileGroup {
	const ref = fileRef(join(root, 'AGENTS.md'), 'AGENTS.md', 'agent');
	return { kind: 'agent', label: GROUP_LABELS.agent, files: ref === null ? [] : [ref] };
}

/** Exact config candidates in fixed order; both files are listed if present. */
function configGroup(root: string, candidates: readonly string[]): FileGroup {
	const files = candidates
		.map((rel) => fileRef(join(root, rel), rel, 'config'))
		.filter((ref): ref is FileRef => ref !== null);
	return { kind: 'config', label: GROUP_LABELS.config, files };
}

/** `agents/` then legacy `agent/`, deduped by basename (current wins). */
function subagentGroup(root: string, prefix: string, legacyPrefix: string): FileGroup {
	const byName = new Map<string, FileRef>();
	for (const ref of mdFilesInDir(join(root, prefix), prefix, 'subagents')) {
		byName.set(ref.name, withSubagentMeta(join(root, ref.path), ref));
	}
	for (const ref of mdFilesInDir(join(root, legacyPrefix), legacyPrefix, 'subagents')) {
		if (!byName.has(ref.name)) byName.set(ref.name, withSubagentMeta(join(root, ref.path), ref));
	}
	const files = [...byName.values()].sort((a, b) => compareNames(a.name, b.name));
	return { kind: 'subagents', label: GROUP_LABELS.subagents, files };
}

/** `skills/<dir>/SKILL.md` then legacy `skill/<dir>/SKILL.md`, deduped by dir. */
function skillGroup(root: string, prefix: string, legacyPrefix: string): FileGroup {
	const byDir = new Map<string, FileRef>();
	const add = (base: string): void => {
		for (const dir of subdirsInDir(join(root, base))) {
			const rel = `${base}/${dir}/SKILL.md`;
			const ref = fileRef(join(root, rel), rel, 'skills');
			if (ref !== null && !byDir.has(dir)) byDir.set(dir, { ...ref, displayName: dir });
		}
	};
	add(prefix);
	add(legacyPrefix);
	const files = [...byDir.entries()]
		.sort((a, b) => compareNames(a[0], b[0]))
		.map(([, ref]) => ref);
	return { kind: 'skills', label: GROUP_LABELS.skills, files };
}

/** `references/*.md` / `templates/*.md` (global-only), sorted by filename. */
function simpleGroup(root: string, prefix: 'references' | 'templates'): FileGroup {
	return {
		kind: prefix,
		label: GROUP_LABELS[prefix],
		files: mdFilesInDir(join(root, prefix), prefix, prefix)
	};
}

function globalGroups(root: string): FileGroup[] {
	return orderGroups([
		agentGroup(root),
		subagentGroup(root, 'agents', 'agent'),
		skillGroup(root, 'skills', 'skill'),
		configGroup(root, GLOBAL_CONFIG_CANDIDATES),
		simpleGroup(root, 'references'),
		simpleGroup(root, 'templates')
	]);
}

function projectGroups(root: string): FileGroup[] {
	return orderGroups([
		agentGroup(root),
		subagentGroup(root, '.opencode/agents', '.opencode/agent'),
		skillGroup(root, '.opencode/skills', '.opencode/skill'),
		configGroup(root, PROJECT_CONFIG_CANDIDATES)
	]);
}

/** `groups` is lazy so a missing/unreadable root performs no directory scan. */
function makeBlock(
	id: string,
	scope: 'global' | 'project',
	name: string,
	root: string,
	groups: () => FileGroup[]
): FileBlock {
	const available = isDirectory(root);
	return { id, scope, name, worktree: root, available, groups: available ? groups() : [] };
}

/**
 * The block index: global config first, then one block per opencode project
 * (excluding the `global` pseudo-project). A missing `project` table or an
 * unreachable DB degrades to `projectsAvailable:false` and never throws.
 */
export function listFileBlocks(): FileIndex {
	const globalRoot = configDir();
	const blocks: FileBlock[] = [
		makeBlock(blockId('global'), 'global', 'Global opencode config', globalRoot, () =>
			globalGroups(globalRoot)
		)
	];
	const { entries, available } = projectEntries();
	for (const entry of entries) {
		blocks.push(
			makeBlock(blockId('project', entry.id), 'project', entry.name, entry.worktree, () =>
				projectGroups(entry.worktree)
			)
		);
	}
	return { blocks, projectsAvailable: available };
}
