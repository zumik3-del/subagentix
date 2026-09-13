/**
 * Read the configured subagents' `.md` frontmatter and find agent directories
 * on the same host.
 *
 * Server-only, bounded and read-only: a missing/unreadable directory degrades
 * to an empty result and discovery never throws. The optional `agentsPath`
 * setting (ADR §4) overrides the default opencode config scan.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { agentColorVar, parseAgentFrontmatter } from '$lib/model/agent';
import { resolveAgentsPath } from './settings';

/** One subagent parsed from an `agents/*.md` file. */
export interface AgentInfo {
	name: string;
	file: string;
	description: string | null;
	model: string | null;
	mode: string | null;
	color: string | null;
	colorVar: string | null;
	temperature: string | null;
}

export interface AgentListing {
	dir: string;
	agents: AgentInfo[];
}

export interface AgentDirCandidate {
	path: string;
	agentCount: number;
}

export interface AgentDiscovery {
	candidates: AgentDirCandidate[];
	recommended: string | null;
}

const DISCOVERY_PARENT_DEPTH = 3;

/** Canonical opencode config root; `OPENCODE_CONFIG_DIR` overrides `~/.config/opencode`. */
function configDir(): string {
	return process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), '.config', 'opencode');
}

/** Parse every readable `*.md` in `dir`, sorted by agent name; missing dir -> []. */
function agentsInDir(dir: string): AgentInfo[] {
	const agents: AgentInfo[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
		let text: string;
		try {
			text = readFileSync(join(dir, entry.name), 'utf8');
		} catch {
			// An unreadable file is just an agent without metadata.
			continue;
		}
		const meta = parseAgentFrontmatter(text);
		agents.push({
			name: entry.name.slice(0, -3),
			file: entry.name,
			description: meta.description,
			model: meta.model,
			mode: meta.mode,
			color: meta.color,
			colorVar: agentColorVar(meta.color),
			temperature: meta.temperature
		});
	}
	return agents;
}

/**
 * List the subagents in one directory. When `dir` is omitted/blank the
 * effective `agentsPath` setting is used; if that is also unset the default
 * opencode `agents/` and legacy `agent/` directories are merged.
 */
export function listAgents(dir?: string | null): AgentListing {
	const explicit = dir?.trim() ? resolve(dir) : (resolveAgentsPath() ?? '');
	if (explicit !== '') return { dir: explicit, agents: agentsInDir(explicit) };

	const merged = new Map<string, AgentInfo>();
	for (const candidate of defaultAgentDirs()) {
		for (const agent of agentsInDir(candidate)) {
			if (!merged.has(agent.name)) merged.set(agent.name, agent);
		}
	}
	return { dir: configDir(), agents: [...merged.values()] };
}

/** Default directories scanned when no `agentsPath` is configured. */
function defaultAgentDirs(): string[] {
	const root = configDir();
	return [join(root, 'agent'), join(root, 'agents')];
}

/**
 * Discover agent directories in standard places: the explicitly configured
 * path, `$OPENCODE_CONFIG_DIR`/`~/.config/opencode` (`agents/` and legacy
 * `agent/`), and `.opencode/agent(s)` from the working directory up to three
 * parents. Only directories containing at least one `.md` are candidates.
 */
export function discoverAgentDirs(): AgentDiscovery {
	try {
		const dirs: string[] = [];
		const seen = new Set<string>();
		const add = (candidate: string | null | undefined): void => {
			if (!candidate) return;
			const resolved = resolve(candidate);
			if (seen.has(resolved)) return;
			seen.add(resolved);
			if (!existsSync(resolved)) return;
			if (agentsInDir(resolved).length > 0) dirs.push(resolved);
		};

		add(resolveAgentsPath());
		const root = configDir();
		add(join(root, 'agents'));
		add(join(root, 'agent'));

		const cwd = process.cwd();
		let parent = cwd;
		add(join(parent, '.opencode', 'agents'));
		add(join(parent, '.opencode', 'agent'));
		for (let depth = 0; depth < DISCOVERY_PARENT_DEPTH; depth++) {
			const next = dirname(parent);
			if (next === parent) break;
			parent = next;
			add(join(parent, '.opencode', 'agents'));
			add(join(parent, '.opencode', 'agent'));
		}

		const candidates: AgentDirCandidate[] = dirs.map((path) => ({
			path,
			agentCount: agentsInDir(path).length
		}));
		return { candidates, recommended: candidates[0]?.path ?? null };
	} catch {
		return { candidates: [], recommended: null };
	}
}
