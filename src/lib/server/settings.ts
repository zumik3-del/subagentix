/**
 * Runtime settings store (task #257, ADR `2026-09-12-adr-runtime-settings.md` §4).
 *
 * Owns the persisted `settings.json` file: path resolution, read/normalise,
 * validation, an in-memory cache, atomic writes and change events. It never
 * imports `db.ts` (no cycle); `db.ts` subscribes to this module instead.
 *
 * Precedence for effective values: stored file -> environment -> hardcoded
 * default. The environment is only ever a fallback, never written back.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_FILTER, SCOPE_ALL } from '$lib/components/features/dashboard/filter';
import { isDashboardPeriod } from '$lib/model/dashboard';
import type { DashboardFilter } from '$lib/model/dashboard';
import { DEFAULT_WIDGETS, resolvePlacements } from '$lib/widgets/registry';
import type { WidgetPlacement } from '$lib/widgets/registry';

/** Hardcoded fallback when neither the file nor `OPENCODE_DB` supplies a path. */
export const DEFAULT_DB_PATH = '/home/opencode/.local/share/opencode/opencode.db';

const MAX_DB_PATH_LENGTH = 4096;

/** Defensive upper bound on a stored filter scope (a directory path). */
const MAX_SCOPE_LENGTH = 4096;

/** Defensive upper bound on a `dashboardWidgets` list (registry has far fewer). */
const MAX_DASHBOARD_WIDGETS = 24;

export type SettingsField =
	| 'dbPath'
	| 'ziptaskBaseUrl'
	| 'ziptaskEnabled'
	| 'agentsPath'
	| 'dashboardWidgets'
	| 'dashboardFilter';

export interface StoredSettings {
	dbPath?: string | null;
	ziptaskBaseUrl?: string | null;
	ziptaskEnabled?: boolean | null;
	agentsPath?: string | null;
	dashboardWidgets?: WidgetPlacement[] | null;
	dashboardFilter?: DashboardFilter | null;
}

/** Validation failure carrying the offending field for the 400 API contract. */
export class SettingsValidationError extends Error {
	readonly field: SettingsField;

	constructor(message: string, field: SettingsField) {
		super(message);
		this.name = 'SettingsValidationError';
		this.field = field;
	}
}

type SettingsListener = (next: StoredSettings) => void;

/** Explicit `SETTINGS_FILE` -> systemd `STATE_DIRECTORY` -> dev `./.data`. */
export function settingsFilePath(): string {
	if (process.env.SETTINGS_FILE) return process.env.SETTINGS_FILE;
	const stateDir = process.env.STATE_DIRECTORY;
	if (stateDir) return join(stateDir, 'settings.json');
	return join(process.cwd(), '.data', 'settings.json');
}

/** Validate/normalise a `dbPath` value; throws `SettingsValidationError`. */
export function normaliseDbPath(value: unknown): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new SettingsValidationError('dbPath must be a non-empty absolute path.', 'dbPath');
	}
	if (value.includes('\0')) {
		throw new SettingsValidationError('dbPath must not contain NUL characters.', 'dbPath');
	}
	if (value.length > MAX_DB_PATH_LENGTH) {
		throw new SettingsValidationError(`dbPath must be at most ${MAX_DB_PATH_LENGTH} characters.`, 'dbPath');
	}
	if (!isAbsolute(value)) {
		throw new SettingsValidationError('dbPath must be an absolute path.', 'dbPath');
	}
	return resolve(value);
}

/** Validate/normalise a `ziptaskBaseUrl` value; throws `SettingsValidationError`. */
export function normaliseZiptaskBaseUrl(value: unknown): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new SettingsValidationError('ziptaskBaseUrl must be a non-empty http(s) URL.', 'ziptaskBaseUrl');
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new SettingsValidationError('ziptaskBaseUrl must be a valid URL.', 'ziptaskBaseUrl');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new SettingsValidationError('ziptaskBaseUrl must use http or https.', 'ziptaskBaseUrl');
	}
	if (url.hostname === '') {
		throw new SettingsValidationError('ziptaskBaseUrl must include a host.', 'ziptaskBaseUrl');
	}
	if (url.username !== '' || url.password !== '') {
		throw new SettingsValidationError('ziptaskBaseUrl must not embed credentials.', 'ziptaskBaseUrl');
	}
	let pathname = url.pathname;
	while (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
	if (pathname === '/') pathname = '';
	return `${url.origin}${pathname}`;
}

/** Validate a `ziptaskEnabled` value; throws `SettingsValidationError`. */
export function normaliseZiptaskEnabled(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		throw new SettingsValidationError('ziptaskEnabled must be a boolean.', 'ziptaskEnabled');
	}
	return value;
}

/** Validate/normalise an `agentsPath` value; throws `SettingsValidationError`. */
export function normaliseAgentsPath(value: unknown): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new SettingsValidationError('agentsPath must be a non-empty absolute path.', 'agentsPath');
	}
	if (value.includes('\0')) {
		throw new SettingsValidationError('agentsPath must not contain NUL characters.', 'agentsPath');
	}
	if (value.length > MAX_DB_PATH_LENGTH) {
		throw new SettingsValidationError(
			`agentsPath must be at most ${MAX_DB_PATH_LENGTH} characters.`,
			'agentsPath'
		);
	}
	if (!isAbsolute(value)) {
		throw new SettingsValidationError('agentsPath must be an absolute path.', 'agentsPath');
	}
	return resolve(value);
}

/**
 * Validate/normalise a `dashboardWidgets` value; throws `SettingsValidationError`.
 *
 * Accepts the current shape (`{id,width,height,x,y}` objects) and the legacy
 * `string[]` ids; unknown ids are dropped, duplicates collapsed and the
 * survivors returned in widget-registry order (the same order the picker and
 * grid rely on). A missing size/position falls back to the registry default /
 * auto-position and an out-of-range size/position is clamped (`resolvePlacements`
 * does both). A non-array, a non-string/non-object entry, a non-finite
 * width/height/x/y or an oversized list is rejected so a malformed payload never
 * reaches disk. Note `x`/`y` follow the size policy exactly: a non-finite value
 * is a 400, an out-of-range one is clamped, and a lone `x` or `y` is accepted
 * and treated as unpositioned downstream.
 */
export function normaliseDashboardWidgets(value: unknown): WidgetPlacement[] {
	if (!Array.isArray(value)) {
		throw new SettingsValidationError(
			'dashboardWidgets must be an array of widget placements.',
			'dashboardWidgets'
		);
	}
	if (value.length > MAX_DASHBOARD_WIDGETS) {
		throw new SettingsValidationError(
			`dashboardWidgets must contain at most ${MAX_DASHBOARD_WIDGETS} entries.`,
			'dashboardWidgets'
		);
	}
	for (const entry of value) {
		if (typeof entry === 'string') continue;
		if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
			const record = entry as Record<string, unknown>;
			if (record.width !== undefined && !Number.isFinite(record.width)) {
				throw new SettingsValidationError(
					'dashboardWidgets width must be a finite number.',
					'dashboardWidgets'
				);
			}
			if (record.height !== undefined && !Number.isFinite(record.height)) {
				throw new SettingsValidationError(
					'dashboardWidgets height must be a finite number.',
					'dashboardWidgets'
				);
			}
			if (record.x !== undefined && !Number.isFinite(record.x)) {
				throw new SettingsValidationError(
					'dashboardWidgets x must be a finite number.',
					'dashboardWidgets'
				);
			}
			if (record.y !== undefined && !Number.isFinite(record.y)) {
				throw new SettingsValidationError(
					'dashboardWidgets y must be a finite number.',
					'dashboardWidgets'
				);
			}
			continue;
		}
		throw new SettingsValidationError(
			'dashboardWidgets must contain only ids or {id,width,height,x,y} objects.',
			'dashboardWidgets'
		);
	}
	return resolvePlacements(value);
}

/**
 * Validate/normalise a `dashboardFilter` value; throws `SettingsValidationError`.
 *
 * The pair must be an object with a known period preset and a scope that is
 * either `null`, a string or the `all`/blank sentinel (both meaning every
 * directory, normalised to `null`). A NUL or an oversized scope is rejected so
 * a malformed payload never reaches disk; known-directory membership is not
 * checked here (the store has no DB access) — `parseFilter` drops an unknown
 * stored scope when it builds the filter.
 */
export function normaliseDashboardFilter(value: unknown): DashboardFilter {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new SettingsValidationError(
			'dashboardFilter must be a { period, scope } object.',
			'dashboardFilter'
		);
	}
	const record = value as Record<string, unknown>;
	const period = record.period;
	if (!isDashboardPeriod(period)) {
		throw new SettingsValidationError(
			'dashboardFilter.period must be a known period preset.',
			'dashboardFilter'
		);
	}
	const rawScope = record.scope;
	let scope: string | null;
	if (rawScope === null) {
		scope = null;
	} else if (typeof rawScope === 'string') {
		if (rawScope.includes('\0')) {
			throw new SettingsValidationError(
				'dashboardFilter.scope must not contain NUL characters.',
				'dashboardFilter'
			);
		}
		if (rawScope.length > MAX_SCOPE_LENGTH) {
			throw new SettingsValidationError(
				`dashboardFilter.scope must be at most ${MAX_SCOPE_LENGTH} characters.`,
				'dashboardFilter'
			);
		}
		scope = rawScope === '' || rawScope === SCOPE_ALL ? null : rawScope;
	} else {
		throw new SettingsValidationError(
			'dashboardFilter.scope must be a string or null.',
			'dashboardFilter'
		);
	}
	return { period, scope };
}

/** Pick the known keys off a parsed file, dropping values that fail validation. */
function normaliseStored(raw: Record<string, unknown>): StoredSettings {
	const out: StoredSettings = {};
	if (typeof raw.dbPath === 'string') {
		try {
			out.dbPath = normaliseDbPath(raw.dbPath);
		} catch {
			// A hand-edited invalid value is ignored, never fatal.
		}
	}
	if (typeof raw.ziptaskBaseUrl === 'string') {
		try {
			out.ziptaskBaseUrl = normaliseZiptaskBaseUrl(raw.ziptaskBaseUrl);
		} catch {
			// Same as above.
		}
	}
	if (typeof raw.ziptaskEnabled === 'boolean') {
		out.ziptaskEnabled = raw.ziptaskEnabled;
	}
	if (typeof raw.agentsPath === 'string') {
		try {
			out.agentsPath = normaliseAgentsPath(raw.agentsPath);
		} catch {
			// Same as above.
		}
	}
	if (Array.isArray(raw.dashboardWidgets)) {
		try {
			out.dashboardWidgets = normaliseDashboardWidgets(raw.dashboardWidgets);
		} catch {
			// A hand-edited invalid list degrades to the registry defaults.
		}
	}
	if (raw.dashboardFilter !== null && typeof raw.dashboardFilter === 'object') {
		try {
			out.dashboardFilter = normaliseDashboardFilter(raw.dashboardFilter);
		} catch {
			// A hand-edited invalid filter degrades to the first-visit default.
		}
	}
	return out;
}

/**
 * Read the settings file. A missing, corrupt or wrongly shaped file degrades to
 * `{}` (all values fall back to env/default) and is never rewritten on read.
 */
function readSettingsFile(file: string): StoredSettings {
	if (!existsSync(file)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			console.warn(`[settings] ignoring "${file}": expected a JSON object.`);
			return {};
		}
		return normaliseStored(parsed as Record<string, unknown>);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[settings] ignoring unreadable "${file}": ${message}`);
		return {};
	}
}

let cachedPath: string | null = null;
let cached: StoredSettings = {};
const listeners = new Set<SettingsListener>();

/** Cached stored overrides; re-read when the resolved file path changes. */
export function getStoredSettings(): StoredSettings {
	const file = settingsFilePath();
	if (cachedPath !== file) {
		cachedPath = file;
		cached = readSettingsFile(file);
	}
	return { ...cached };
}

function emit(next: StoredSettings): void {
	for (const listener of [...listeners]) {
		try {
			listener(next);
		} catch (error) {
			// A subscriber must never break a successful write.
			console.warn('[settings] change listener failed:', error);
		}
	}
}

/** Atomically persist settings (tmp file + rename, mode 0600). */
function writeSettingsFile(settings: StoredSettings): void {
	const file = settingsFilePath();
	mkdirSync(dirname(file), { recursive: true });
	const payload: Record<string, unknown> = { version: 2 };
	if (settings.dbPath !== undefined) payload.dbPath = settings.dbPath;
	if (settings.ziptaskBaseUrl !== undefined) payload.ziptaskBaseUrl = settings.ziptaskBaseUrl;
	if (settings.ziptaskEnabled !== undefined) payload.ziptaskEnabled = settings.ziptaskEnabled;
	if (settings.agentsPath !== undefined) payload.agentsPath = settings.agentsPath;
	if (settings.dashboardWidgets !== undefined) payload.dashboardWidgets = settings.dashboardWidgets;
	if (settings.dashboardFilter !== undefined) payload.dashboardFilter = settings.dashboardFilter;
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

/**
 * Apply a partial update: absent key = unchanged, `null` = clear the override.
 * Validates and normalises before writing; on write failure the in-memory cache
 * is left untouched and the error propagates.
 */
export function updateStoredSettings(patch: StoredSettings): StoredSettings {
	const current = getStoredSettings();
	const next: StoredSettings = { ...current };
	if (Object.prototype.hasOwnProperty.call(patch, 'dbPath')) {
		next.dbPath = patch.dbPath === null ? null : normaliseDbPath(patch.dbPath);
	}
	if (Object.prototype.hasOwnProperty.call(patch, 'ziptaskBaseUrl')) {
		next.ziptaskBaseUrl =
			patch.ziptaskBaseUrl === null ? null : normaliseZiptaskBaseUrl(patch.ziptaskBaseUrl);
	}
	if (Object.prototype.hasOwnProperty.call(patch, 'ziptaskEnabled')) {
		next.ziptaskEnabled =
			patch.ziptaskEnabled === null ? null : normaliseZiptaskEnabled(patch.ziptaskEnabled);
	}
	if (Object.prototype.hasOwnProperty.call(patch, 'agentsPath')) {
		next.agentsPath = patch.agentsPath === null ? null : normaliseAgentsPath(patch.agentsPath);
	}
	if (Object.prototype.hasOwnProperty.call(patch, 'dashboardWidgets')) {
		next.dashboardWidgets =
			patch.dashboardWidgets === null ? null : normaliseDashboardWidgets(patch.dashboardWidgets);
	}
	if (Object.prototype.hasOwnProperty.call(patch, 'dashboardFilter')) {
		next.dashboardFilter =
			patch.dashboardFilter === null ? null : normaliseDashboardFilter(patch.dashboardFilter);
	}
	writeSettingsFile(next);
	cachedPath = settingsFilePath();
	cached = next;
	emit(next);
	return { ...next };
}

/** Effective opencode DB path: file override -> env -> hardcoded default. */
export function resolveDbPath(): string {
	return getStoredSettings().dbPath ?? process.env.OPENCODE_DB ?? DEFAULT_DB_PATH;
}

/** Effective ziptask base URL: file override -> env -> `null` (unset). */
export function resolveZiptaskBaseUrl(): string | null {
	return getStoredSettings().ziptaskBaseUrl ?? process.env.ZIPTASK_BASE_URL ?? null;
}

/**
 * Effective ziptask integration toggle: file override -> `ZIPTASK_ENABLED`
 * env -> derived (`true` when a base URL resolves). The env layer is a soft
 * default, matching the store's file > env > default precedence, so an explicit
 * stored value always wins.
 */
export function resolveZiptaskEnabled(): boolean {
	const stored = getStoredSettings().ziptaskEnabled;
	if (typeof stored === 'boolean') return stored;
	const env = process.env.ZIPTASK_ENABLED?.trim().toLowerCase();
	if (env === '1' || env === 'true' || env === 'yes' || env === 'on') return true;
	if (env === '0' || env === 'false' || env === 'no' || env === 'off') return false;
	return resolveZiptaskBaseUrl() !== null;
}

/** Effective subagents directory: file override -> env -> `null` (use default scan). */
export function resolveAgentsPath(): string | null {
	return getStoredSettings().agentsPath ?? process.env.OPENCODE_AGENTS_DIR ?? null;
}

/**
 * Effective dashboard widget placements: stored selection -> {@link
 * DEFAULT_WIDGETS} (first visit). There is no environment layer — this is UI
 * state. The stored value was normalised on read, and is re-resolved here so
 * the result is always deduped, clamped and in registry order.
 */
export function resolveDashboardWidgets(): WidgetPlacement[] {
	return resolvePlacements(getStoredSettings().dashboardWidgets ?? DEFAULT_WIDGETS);
}

/**
 * Effective dashboard filter preference: stored pair -> {@link DEFAULT_FILTER}
 * (first visit). There is no environment layer — this is UI state. A cleared
 * override (`null`) falls back to the default, exactly like the widget
 * selection; the stored value was validated on read.
 */
export function resolveDashboardFilter(): DashboardFilter {
	return { ...(getStoredSettings().dashboardFilter ?? DEFAULT_FILTER) };
}

/** Subscribe to successful settings writes; returns an unsubscribe function. */
export function onSettingsChange(listener: SettingsListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
