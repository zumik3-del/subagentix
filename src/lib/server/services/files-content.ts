/**
 * On-demand content read for the `/files` service (epic #775, spec T1).
 *
 * Defence in depth: the pure path allowlist (`isAllowedRelPath`) plus realpath
 * containment (blocks `..` and symlink escape), a stat-before + length-after
 * 512 KiB cap, and EACCES/ENOENT mapped to 403/404. Never reads outside the
 * block root or opencode runtime state.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
	detectBinary,
	isAllowedRelPath,
	MAX_FILE_BYTES,
	parseBlockId,
	PROJECT_BLOCK_PREFIX,
	type FileContent
} from '$lib/model/files';
import {
	configDir,
	errorCode,
	errorMessage,
	findProject,
	type ProjectEntry
} from './files-discovery';

/** Typed §5.2 outcome; the route layer maps `status` to an HTTP response. */
export type FileReadResult =
	| { ok: true; status: 200; content: FileContent }
	| {
			ok: false;
			status: 400 | 403 | 404 | 413 | 503;
			error: string;
			field?: 'block' | 'path';
			size?: number;
			limit?: number;
	  };

/** Map a filesystem error to 403 (`EACCES`/`EPERM`) or 404 (everything else). */
function failure(error: unknown, fallback: string): FileReadResult {
	const code = errorCode(error);
	if (code === 'EACCES' || code === 'EPERM') {
		return { ok: false, status: 403, error: 'File is not readable.' };
	}
	return { ok: false, status: 404, error: fallback };
}

function readUnderRoot(root: string, blockId: string, rel: string): FileReadResult {
	let rootReal: string;
	try {
		rootReal = realpathSync(root);
	} catch (error) {
		return failure(error, 'Block directory not found.');
	}
	let target: string;
	try {
		target = realpathSync(join(rootReal, rel));
	} catch (error) {
		return failure(error, 'File not found.');
	}
	if (target !== rootReal && !target.startsWith(rootReal + sep)) {
		return { ok: false, status: 400, error: 'Path escapes the block root.', field: 'path' };
	}
	let stats;
	try {
		stats = statSync(target);
	} catch (error) {
		return failure(error, 'File not found.');
	}
	if (!stats.isFile()) return { ok: false, status: 404, error: 'File not found.' };
	if (stats.size > MAX_FILE_BYTES) {
		return {
			ok: false,
			status: 413,
			error: 'File is too large to display.',
			size: stats.size,
			limit: MAX_FILE_BYTES
		};
	}
	let bytes: Uint8Array;
	try {
		bytes = readFileSync(target);
	} catch (error) {
		return failure(error, 'File not found.');
	}
	// TOCTOU guard: the file may have grown between stat and read (E13).
	if (bytes.byteLength > MAX_FILE_BYTES) {
		return {
			ok: false,
			status: 413,
			error: 'File is too large to display.',
			size: bytes.byteLength,
			limit: MAX_FILE_BYTES
		};
	}
	const binary = detectBinary(bytes);
	return {
		ok: true,
		status: 200,
		content: {
			block: blockId,
			path: rel,
			content: binary ? null : new TextDecoder('utf-8').decode(bytes),
			binary,
			size: bytes.byteLength,
			mtimeMs: stats.mtimeMs
		}
	};
}

/** Read one allowlisted file by block id + relative path (§5.2 statuses). */
export function readFileContent(blockId: string, rel: string): FileReadResult {
	if (typeof blockId !== 'string' || blockId.trim() === '') {
		return { ok: false, status: 400, error: 'A block id is required.', field: 'block' };
	}
	if (typeof rel !== 'string' || rel.trim() === '') {
		return { ok: false, status: 400, error: 'A file path is required.', field: 'path' };
	}
	const parsed = parseBlockId(blockId);
	if (parsed === null) {
		// `project:` with an empty id is malformed (400); any other unmatched id
		// is simply unknown (404) and never leaks whether a target exists.
		if (blockId.startsWith(PROJECT_BLOCK_PREFIX)) {
			return { ok: false, status: 400, error: `Malformed block id "${blockId}".`, field: 'block' };
		}
		return { ok: false, status: 404, error: `Unknown block "${blockId}".` };
	}
	if (!isAllowedRelPath(parsed.scope, rel)) {
		return { ok: false, status: 400, error: 'Path is not an allowlisted file.', field: 'path' };
	}
	if (parsed.scope === 'global') return readUnderRoot(configDir(), blockId, rel);

	let project: ProjectEntry | null;
	try {
		project = findProject(parsed.projectId);
	} catch (error) {
		return { ok: false, status: 503, error: errorMessage(error) };
	}
	if (project === null) {
		return { ok: false, status: 404, error: `Unknown project block "${blockId}".` };
	}
	return readUnderRoot(project.worktree, blockId, rel);
}
