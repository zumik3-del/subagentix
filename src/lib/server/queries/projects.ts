/**
 * opencode `project` rows backing the `/files` block list (epic #775, T1).
 *
 * The single home of the `project` table SQL (ADR §7.1 layering): only
 * `id`, `worktree` and `name` are read, never any other column. The table
 * probe is cached per connection like `project-link.ts:hasProjectLink()`, so a
 * settings `dbPath` change re-probes the new schema instead of trusting a
 * stale result.
 */
import type { Database } from 'bun:sqlite';
import { getDb } from '../db';
import type { Row } from '../schema';

export interface ProjectRecord {
	id: string;
	worktree: string;
	name: string | null;
}

export interface ProjectRows {
	/** False when the `project` table is absent (older schema). */
	available: boolean;
	rows: ProjectRecord[];
}

let projectTable: boolean | null = null;
let projectTableDb: Database | null = null;

function hasProjectTable(db: Database): boolean {
	if (db === projectTableDb && projectTable !== null) return projectTable;
	projectTableDb = db;
	try {
		const row = db
			.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'project'")
			.get() as Row | null;
		projectTable = row !== null;
	} catch {
		projectTable = false;
	}
	return projectTable;
}

function mapProjectRow(row: Row): ProjectRecord {
	return {
		id: String(row.id ?? ''),
		worktree: String(row.worktree ?? ''),
		name: typeof row.name === 'string' ? row.name : null
	};
}

/** Every `project` row, or `available:false` when the table is absent. */
export function listProjectRows(): ProjectRows {
	const db = getDb();
	if (!hasProjectTable(db)) return { available: false, rows: [] };
	const rows = db.query('SELECT id, worktree, name FROM project').all() as Row[];
	return { available: true, rows: rows.map(mapProjectRow) };
}

/** One `project` row by id, or `null` when the table/row is absent. */
export function findProjectRow(id: string): ProjectRecord | null {
	const db = getDb();
	if (!hasProjectTable(db)) return null;
	const row = db.query('SELECT id, worktree, name FROM project WHERE id = ?').get(id) as Row | null;
	return row === null ? null : mapProjectRow(row);
}
