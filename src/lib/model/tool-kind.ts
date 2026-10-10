/**
 * Client-safe tool/status classifier (epic #512, task #515).
 *
 * The single source of the `basic` / `mcp` rule: `basic` is the opencode
 * built-in allowlist, every other name is MCP. Shared by the server turn view
 * (`services/turn/tool-calls.ts`) and the dashboard tool-kind filter, so it must
 * stay free of server/DB imports and of any DOM/Svelte dependency.
 * Pure and deterministic; no I/O.
 *
 * Membership is exact and case-sensitive (`Bash` is not `bash`). A name the
 * allowlist does not list — a namespaced MCP tool, or the synthesised `unknown`
 * for a NULL/blank tool name — is MCP; `invalid` is explicitly basic.
 * Everything not allowlisted is MCP, so new MCP tools are picked up for free.
 *
 * It also carries the shared definition of a failed tool call
 * ({@link FAILED_TOOL_STATUSES} / {@link isFailedToolStatus}), used by the
 * top-tools aggregate, the tool-error detail and the node step summary so they
 * count the same rows.
 */

/**
 * The opencode built-in tool names; every other name is treated as MCP.
 *
 * `shell`, `execute` and `subagent` are the live V2 built-ins. `bash` and
 * `task` are the removed V1 names, kept because the split only affects the
 * basic/mcp label and historical rows still carry `bash` (spec OQ-3, E-21).
 * `search` and `fetch` are the Code Mode built-ins recorded as nested calls
 * inside `execute` items (ADR D-3).
 */
export const BASIC_TOOL_NAMES: readonly string[] = [
	'bash',
	'shell',
	'execute',
	'read',
	'edit',
	'write',
	'grep',
	'glob',
	'task',
	'subagent',
	'todowrite',
	'webfetch',
	'websearch',
	'search',
	'fetch',
	'skill',
	'question',
	'invalid'
];

const BASIC_TOOL_SET: ReadonlySet<string> = new Set(BASIC_TOOL_NAMES);

/** Tool origin: `basic` = built-in allowlist, `mcp` = everything else. */
export type ToolKind = 'basic' | 'mcp';

/** The delegation tool name (V2 `subagent`, formerly V1 `task`). */
export const DELEGATION_TOOL = 'subagent';
/** The Code Mode entry-point tool name. */
export const CODE_MODE_TOOL = 'execute';

/** Exact (case-sensitive) membership in {@link BASIC_TOOL_NAMES}. */
export function isBasicTool(name: string): boolean {
	return BASIC_TOOL_SET.has(name);
}

/**
 * True for every MCP tool name. A dot-namespaced name (`<server>.<tool>`) is
 * always MCP; every other name falls back to the allowlist check (ADR D-3).
 */
export function isMcpTool(name: string): boolean {
	if (name.includes('.')) return true;
	return !isBasicTool(name);
}

/** The {@link ToolKind} of a tool name, in one place for callers that branch on it. */
export function toolKind(name: string): ToolKind {
	// Delegates to isMcpTool so the dot-namespace rule (ADR D-3) has one source.
	return isMcpTool(name) ? 'mcp' : 'basic';
}

/**
 * Raw content-item `state.status` values treated as a failed tool call
 * (case-insensitive). The single shared definition of "failed": the top-tools
 * aggregate, the tool-error detail and the node step summary all read it, so
 * the widget's errors column, the detail's unfiltered total and the node
 * summary count the same rows.
 */
export const FAILED_TOOL_STATUSES: readonly string[] = ['error', 'failed'];

/** Case-insensitive membership check against {@link FAILED_TOOL_STATUSES}. */
export function isFailedToolStatus(status: string): boolean {
	return FAILED_TOOL_STATUSES.includes(status.toLowerCase());
}
