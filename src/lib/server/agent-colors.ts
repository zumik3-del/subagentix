/**
 * Read the configured opencode agents' `color:` frontmatter (task #239).
 *
 * Scans `${OPENCODE_CONFIG_DIR ?? ~/.config/opencode}/agents/*.md` and the
 * legacy singular `.../agent/*.md` directory. Returns `Record<agent, cssVar>`
 * keyed by the md filename (without `.md`): a missing directory, unreadable
 * file, absent `color:` or unknown token is simply skipped. The result is
 * cached per config dir, so the filesystem is walked once per root.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentColorVar, parseAgentColor } from '$lib/model/agent';
import { resolveAgentsPath } from './settings';

/** opencode's config root; `OPENCODE_CONFIG_DIR` overrides `~/.config/opencode`. */
export function agentConfigDir(): string {
	return process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), '.config', 'opencode');
}

/** Agent directories to scan: the `agentsPath` override, else `agent/` + `agents/`. */
function agentColorDirs(): string[] {
	const configured = resolveAgentsPath();
	if (configured) return [configured];
	const root = agentConfigDir();
	// Legacy singular dir first, then the canonical plural one, so `agents/`
	// wins on a name collision.
	return [join(root, 'agent'), join(root, 'agents')];
}

let cache: { key: string; colors: Record<string, string> } | null = null;

/** Drop the cached colors so the next `getAgentColors()` re-reads the disk. */
export function invalidateAgentColors(): void {
	cache = null;
}

/** Read every `*.md` color in one agent directory into `colors`; missing dir = no-op. */
function readAgentDir(dir: string, colors: Record<string, string>): void {
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
			try {
				const text = readFileSync(join(dir, entry.name), 'utf8');
				const cssVar = agentColorVar(parseAgentColor(text));
				if (cssVar !== null) colors[entry.name.slice(0, -3)] = cssVar;
			} catch {
				// An unreadable file is just an agent without a known color.
			}
		}
	} catch {
		// A missing/unreadable directory degrades to an empty agent set.
	}
}

/**
 * Map every configured agent name to its CSS color variable. Missing/older
 * config directories degrade to `{}`; this never throws. Cached per config dir.
 */
export function getAgentColors(): Record<string, string> {
	const dirs = agentColorDirs();
	const key = dirs.join('\u0000');
	if (cache !== null && cache.key === key) return cache.colors;

	const colors: Record<string, string> = {};
	for (const dir of dirs) readAgentDir(dir, colors);

	cache = { key, colors };
	return colors;
}
