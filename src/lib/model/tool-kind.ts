/**
 * Client-safe tool-kind classifier (epic #512, task #515).
 *
 * The single source of the `basic` / `mcp` rule: `basic` is the opencode
 * built-in allowlist, every other name is MCP. Shared by the server turn view
 * (`services/turn/tool-calls.ts`) and the dashboard tool-kind filter, so it must
 * stay free of server/DB imports and of any DOM/Svelte dependency.
 * Pure and deterministic; no I/O.
 *
 * Membership is exact and case-sensitive (`Bash` is not `bash`). A name the
 * allowlist does not list — a namespaced MCP tool, or the synthesised `unknown`
 * for a NULL/blank `part.data.tool` — is MCP; `invalid` is explicitly basic.
 * Everything not allowlisted is MCP, so new MCP tools are picked up for free.
 */

/** The opencode built-in tool names; every other name is treated as MCP. */
export const BASIC_TOOL_NAMES: readonly string[] = [
	'bash',
	'read',
	'edit',
	'write',
	'grep',
	'glob',
	'task',
	'todowrite',
	'webfetch',
	'websearch',
	'skill',
	'question',
	'invalid'
];

const BASIC_TOOL_SET: ReadonlySet<string> = new Set(BASIC_TOOL_NAMES);

/** Tool origin: `basic` = built-in allowlist, `mcp` = everything else. */
export type ToolKind = 'basic' | 'mcp';

/** Exact (case-sensitive) membership in {@link BASIC_TOOL_NAMES}. */
export function isBasicTool(name: string): boolean {
	return BASIC_TOOL_SET.has(name);
}

/** True for every tool name outside the built-in allowlist (MCP). */
export function isMcpTool(name: string): boolean {
	return !isBasicTool(name);
}

/** The {@link ToolKind} of a tool name, in one place for callers that branch on it. */
export function toolKind(name: string): ToolKind {
	return isBasicTool(name) ? 'basic' : 'mcp';
}
