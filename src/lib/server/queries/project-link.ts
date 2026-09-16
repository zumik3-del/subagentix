/**
 * Schema-capability probe: does the live opencode DB link sessions to projects
 * (`project` table plus a `session.project_id` column)? opencode's schema is not
 * guaranteed, so directory aggregations skip the `project` join when either is
 * absent and `projectName` stays `null`.
 *
 * Kept in its own module (rather than exported from `sessions.ts`, which the
 * dashboard query layer had to reach through) so the probe is a single internal
 * dependency of the directory queries (`listDirectories`,
 * `countSessionsByDirectory`) and not part of the session-query public API
 * (review #419).
 *
 * Cached per connection, not per process: a stable `dbPath` keeps returning the
 * same `Database` from `getDb()` and is probed exactly once, while a settings
 * `dbPath` change makes `getDb()` drop and reopen the handle, so the next query
 * re-probes the new schema instead of trusting a stale result.
 */
import { getDb } from '../db';
import type { Row } from '../schema';

let projectLink: boolean | null = null;
let projectLinkDb: ReturnType<typeof getDb> | null = null;

export function hasProjectLink(): boolean {
	try {
		const db = getDb();
		if (db === projectLinkDb && projectLink !== null) return projectLink;
		projectLinkDb = db;
		const table = db
			.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'project'")
			.get() as Row | null;
		if (table === null) {
			projectLink = false;
			return false;
		}
		const columns = db.query('PRAGMA table_info(session)').all() as Row[];
		projectLink = columns.some((column) => column.name === 'project_id');
	} catch {
		// A missing/older schema must degrade to "no project name", never throw.
		projectLink = false;
	}
	return projectLink;
}
