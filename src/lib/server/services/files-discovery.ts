/**
 * Read-only discovery helpers for the `/files` service (epic #775, spec T1).
 *
 * Server-only and bounded: directory reads never throw (a missing root yields
 * an empty result), scans stop at MAX_ENTRIES_PER_GROUP, and every root is an
 * allowlisted opencode config/project directory — never opencode runtime state
 * (`~/.local/share/opencode`), so credentials and the DB itself are unreachable.
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { MAX_ENTRIES_PER_GROUP, type FileGroupKind, type FileRef } from '$lib/model/files';
import { findProjectRow, listProjectRows } from '../queries/projects';

/** Canonical opencode config root (mirrors `agents.ts:configDir`). */
export function configDir(): string {
	return process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), '.config', 'opencode');
}

/** Deterministic, locale-free name comparison (no `localeCompare`). */
export function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** POSIX error code (`ENOENT`, `EACCES`, ...) or `null`. */
export function errorCode(error: unknown): string | null {
	if (error === null || typeof error !== 'object' || !('code' in error)) return null;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' ? code : null;
}

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** `size`/`mtimeMs` for a regular file, or `null` when missing/not a file. */
function statFile(abs: string): { size: number; mtimeMs: number } | null {
	try {
		const stats = statSync(abs);
		return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
	} catch {
		return null;
	}
}

/** One allowlisted file, or `null` when it is missing/not a regular file. */
export function fileRef(abs: string, rel: string, group: FileGroupKind): FileRef | null {
	const stat = statFile(abs);
	if (stat === null) return null;
	return { path: rel, name: basename(rel), group, size: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * `*.md` files directly under `dir`, sorted by basename and capped at
 * MAX_ENTRIES_PER_GROUP; a missing/unreadable directory yields `[]`.
 */
export function mdFilesInDir(dir: string, relPrefix: string, group: FileGroupKind): FileRef[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: FileRef[] = [];
	for (const entry of entries.sort((a, b) => compareNames(a.name, b.name))) {
		if (files.length >= MAX_ENTRIES_PER_GROUP) break;
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
		const rel = `${relPrefix}/${entry.name}`;
		const ref = fileRef(join(dir, entry.name), rel, group);
		if (ref !== null) files.push(ref);
	}
	return files;
}

/** Subdirectory names under `dir`, sorted and capped; missing dir -> []. */
export function subdirsInDir(dir: string): string[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort(compareNames)
		.slice(0, MAX_ENTRIES_PER_GROUP);
}

/** Display name: stored name when non-blank, else the worktree basename. */
export function displayName(rawName: unknown, worktree: string): string {
	const name = typeof rawName === 'string' ? rawName : '';
	if (name.trim() !== '') return name;
	const base = basename(worktree);
	return base !== '' ? base : worktree;
}

export interface ProjectEntry {
	id: string;
	worktree: string;
	name: string;
}

/**
 * Project blocks from the opencode `project` table, excluding the `global`
 * pseudo-project (`id='global'`/`worktree='/'`); a missing table or an
 * unreachable DB yields `available:false` (never a throw). Sorted by
 * `(name.toLowerCase(), worktree)`.
 */
export function projectEntries(): { entries: ProjectEntry[]; available: boolean } {
	try {
		const result = listProjectRows();
		if (!result.available) return { entries: [], available: false };
		const entries: ProjectEntry[] = [];
		for (const row of result.rows) {
			if (row.id === '' || row.worktree === '') continue;
			if (row.id === 'global' || row.worktree === '/') continue;
			const name = displayName(row.name, row.worktree);
			entries.push({ id: row.id, worktree: row.worktree, name });
		}
		entries.sort(
			(a, b) =>
				compareNames(a.name.toLowerCase(), b.name.toLowerCase()) ||
				compareNames(a.worktree, b.worktree)
		);
		return { entries, available: true };
	} catch {
		return { entries: [], available: false };
	}
}

/**
 * Resolve one project id; `null` when the table/id is unknown. Throws when the
 * DB itself is unreachable (the content read maps that to 503).
 */
export function findProject(projectId: string): ProjectEntry | null {
	const row = findProjectRow(projectId);
	if (row === null || row.worktree === '') return null;
	return { id: row.id, worktree: row.worktree, name: displayName(row.name, row.worktree) };
}
