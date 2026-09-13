/**
 * Same-host autodiscovery (task #257, ADR §7).
 *
 * Server-side, bounded, read-only and non-writing. Returns only concrete
 * candidate values (never a directory listing) and never throws: a not-found
 * scan degrades to an empty result.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { probeOpencodeDb } from './db-probe';
import { getStoredSettings } from './settings';

const OPENCODE_CANDIDATE_CAP = 8;
const ZIPTASK_PROBE_TIMEOUT_MS = 800;

export interface OpencodeCandidate {
	path: string;
	sessions: number;
	mtimeMs: number;
}

export interface OpencodeDiscovery {
	candidates: OpencodeCandidate[];
	recommended: string | null;
}

export interface ZiptaskCandidate {
	baseUrl: string;
	source: 'settings-json' | 'probe';
}

export interface ZiptaskDiscovery {
	candidates: ZiptaskCandidate[];
	recommended: string | null;
}

function dedupe(paths: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

/** Bounded, priority-ordered opencode DB candidate paths (ADR §7.1). */
function opencodeCandidatePaths(extraPaths: string[]): string[] {
	const roots = [...extraPaths];
	const env = process.env.OPENCODE_DB;
	if (env && isAbsolute(env)) roots.push(env);
	const stored = getStoredSettings().dbPath;
	if (stored) roots.push(stored);
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg) roots.push(join(xdg, 'opencode', 'opencode.db'));
	const home = process.env.HOME ?? homedir();
	if (home) roots.push(join(home, '.local', 'share', 'opencode', 'opencode.db'));
	const cwd = process.cwd();
	roots.push(join(cwd, 'opencode.db'));
	let parent = cwd;
	for (let depth = 0; depth < 3; depth++) {
		const next = dirname(parent);
		if (next === parent) break;
		parent = next;
		roots.push(join(parent, 'opencode.db'));
	}
	return dedupe(roots).slice(0, OPENCODE_CANDIDATE_CAP);
}

/**
 * Discover opencode DBs. `extraPaths` lets the UI re-probe its current field
 * value; those paths are tried first so a valid typed path wins. The
 * recommended entry is the highest-priority candidate that passed the probe.
 */
export function discoverOpencodeDbs(options: { extraPaths?: string[] } = {}): OpencodeDiscovery {
	try {
		const candidates: OpencodeCandidate[] = [];
		for (const path of opencodeCandidatePaths(options.extraPaths ?? [])) {
			const probe = probeOpencodeDb(path);
			if (probe) candidates.push(probe);
		}
		return { candidates, recommended: candidates[0]?.path ?? null };
	} catch {
		return { candidates: [], recommended: null };
	}
}

function ziptaskSettingsPath(): string {
	const home = process.env.ZIPTASK_HOME ?? homedir();
	return join(home, '.ziptask', 'settings.json');
}

interface ZiptaskConfig {
	baseUrl: string;
	port: number;
}

/** Parse `${ZIPTASK_HOME ?? ~/.ziptask}/settings.json`; `null` when unusable. */
function readZiptaskConfig(): ZiptaskConfig | null {
	try {
		const file = ziptaskSettingsPath();
		if (!existsSync(file)) return null;
		const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const { host, port } = parsed as { host?: unknown; port?: unknown };
		if (typeof host !== 'string') return null;
		if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
		const normalised = host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
		const authority = /^[\w.-]+$/.test(normalised) ? normalised : `[${normalised}]`;
		const url = new URL(`http://${authority}:${port}`);
		return { baseUrl: url.origin, port };
	} catch {
		return null;
	}
}

async function probeZiptaskPort(port: number): Promise<string | null> {
	const baseUrl = `http://127.0.0.1:${port}`;
	try {
		const response = await fetch(`${baseUrl}/health`, {
			signal: AbortSignal.timeout(ZIPTASK_PROBE_TIMEOUT_MS)
		});
		if (!response.ok) return null;
		const body: unknown = await response.json();
		if (body !== null && typeof body === 'object' && (body as { ok?: unknown }).ok === true) {
			return baseUrl;
		}
		return null;
	} catch {
		return null;
	}
}

/** Discover ziptask base URLs from the config file plus bounded localhost probes. */
export async function discoverZiptaskBaseUrls(): Promise<ZiptaskDiscovery> {
	try {
		const candidates: ZiptaskCandidate[] = [];
		const seen = new Set<string>();
		const config = readZiptaskConfig();
		if (config) {
			seen.add(config.baseUrl);
			candidates.push({ baseUrl: config.baseUrl, source: 'settings-json' });
		}

		const ports = [...new Set([config?.port ?? 3005, 3005, 3006])].slice(0, 4);
		const results = await Promise.allSettled(ports.map((port) => probeZiptaskPort(port)));
		for (const result of results) {
			if (result.status !== 'fulfilled' || result.value === null || seen.has(result.value)) continue;
			seen.add(result.value);
			candidates.push({ baseUrl: result.value, source: 'probe' });
		}
		return { candidates, recommended: candidates[0]?.baseUrl ?? null };
	} catch {
		return { candidates: [], recommended: null };
	}
}
