/**
 * opencode agent-color adapter (task #239).
 *
 * An agent's `.md` frontmatter carries a semantic `color:` token; this module
 * maps those tokens to the app's existing CSS custom properties and parses the
 * token out of frontmatter. It is imported by both the server (which reads the
 * md files) and the client Gantt (which renders the swatch), so it must stay
 * free of `$lib/server`, DB and filesystem imports.
 */

/**
 * opencode semantic color tokens mapped to the app's semantic status tokens
 * (docs/ui-standards.md §4). Kept as `var(...)` references so the swatch follows
 * the active theme. `primary`/`secondary` stay on the neutral icon tokens.
 */
export const AGENT_COLOR_VARS: Record<string, string> = {
	primary: 'var(--icon-strong-base)',
	secondary: 'var(--icon-base)',
	accent: 'var(--color-accent-base)',
	success: 'var(--color-success-base)',
	warning: 'var(--color-warning-base)',
	error: 'var(--color-danger-base)',
	info: 'var(--color-info-base)'
};

/**
 * Neutral fallback for an agent whose `.md` carries no (or an unknown) `color:`
 * token — e.g. the built-in `build` agent. A gray token, so a colorless agent
 * reads as neutral instead of borrowing a model color (task #253).
 */
export const AGENT_FALLBACK_COLOR = 'var(--icon-base)';

/**
 * Resolve an agent color token to its CSS variable reference, or `null` when
 * the token is missing/unknown. Case- and whitespace-insensitive so a sloppy
 * frontmatter value still resolves.
 */
export function agentColorVar(token: string | null | undefined): string | null {
	if (token == null) return null;
	const key = token.trim().toLowerCase();
	return AGENT_COLOR_VARS[key] ?? null;
}

/** Frontmatter fields surfaced for the settings subagent list. */
export interface AgentFrontmatter {
	name: string | null;
	description: string | null;
	model: string | null;
	mode: string | null;
	color: string | null;
	temperature: string | null;
}

/** Extract the leading YAML frontmatter body, or `null` when absent. */
function frontmatterBlock(mdText: string): string | null {
	const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(mdText);
	return match === null ? null : match[1];
}

/** Drop an inline `# comment` (only when preceded by whitespace), then unquote. */
function scalarValue(raw: string): string {
	const hash = raw.search(/\s#/);
	const uncommented = hash === -1 ? raw : raw.slice(0, hash);
	return uncommented.replace(/^['"]|['"]$/g, '').trim();
}

/**
 * Parse the top-level scalar keys of an agent `.md` frontmatter. Nested blocks
 * (`permission:`) and unknown keys are ignored. Values keep inline comments
 * stripped, so `model: foo # note` yields `foo`.
 */
export function parseAgentFrontmatter(mdText: string): AgentFrontmatter {
	const meta: AgentFrontmatter = {
		name: null,
		description: null,
		model: null,
		mode: null,
		color: null,
		temperature: null
	};
	const block = frontmatterBlock(mdText);
	if (block === null) return meta;
	for (const line of block.split(/\r?\n/)) {
		const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
		if (match === null) continue;
		const key = match[1].toLowerCase() as keyof AgentFrontmatter;
		if (!(key in meta)) continue;
		const value = scalarValue(match[2]);
		if (value !== '') meta[key] = value;
	}
	return meta;
}

/**
 * Extract the `color:` value from an agent markdown file's YAML frontmatter.
 * Returns the raw (unquoted) token, or `null` when there is no frontmatter or
 * no `color:` key. Only the leading `---` block is inspected, so a `color:` in
 * the body is never mistaken for metadata.
 */
export function parseAgentColor(mdText: string): string | null {
	return parseAgentFrontmatter(mdText).color;
}
