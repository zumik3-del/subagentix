/**
 * Pure view logic for the top-tools widget (dashboard Phase 4, task #413).
 *
 * Kept out of the Svelte body so the count/error-share mapping and the
 * capped-note decision are testable without a renderer or a DOM, mirroring the
 * `data.svelte.ts` helper split (docs/ui-standards.md §10). No DOM, no Svelte
 * and no `$lib/server` import.
 */
import { MAX_TOOL_SESSIONS, type DashboardPeriod, type ToolUsage } from '$lib/model/dashboard';
import { formatNumber } from '$lib/model/format';

/** One `BarChart` row for the top-tools widget. */
export interface TopToolBar {
	/** Tool name. */
	label: string;
	/** Call count (bar length and ranked value). */
	value: number;
	/** Tooltip with the exact error count behind the share. */
	title: string;
	/** Visible error share, e.g. `12% errors`. */
	detail: string;
}

/** Share of a tool's calls that errored, as a rounded percent label. */
export function errorShareLabel(share: number): string {
	const percent = Number.isFinite(share) ? Math.round(share * 100) : 0;
	return `${percent}% errors`;
}

/**
 * Map the Tier-P rows onto `BarChart` rows, preserving the server's rank order
 * (count desc, name asc). The bar value is the call count; the visible detail is
 * the error share and the tooltip carries the exact error count.
 */
export function topToolBars(usage: ToolUsage): TopToolBar[] {
	return usage.tools.map((tool) => ({
		label: tool.name,
		value: tool.count,
		title: `${formatNumber(tool.errors)} of ${formatNumber(tool.count)} calls errored`,
		detail: errorShareLabel(tool.errorShare)
	}));
}

/**
 * Visible note explaining why the tool counts are not an exact window total, or
 * `null` when they are exact. Covers both the truncated Tier-P read (`capped`
 * at {@link MAX_TOOL_SESSIONS} sessions) and the unbounded `period=all` slow
 * path (spec R1/AC P4.3-3).
 */
export function topToolsNote(usage: ToolUsage, period: DashboardPeriod): string | null {
	if (usage.capped) {
		return `Approximate — only the most recent ${formatNumber(MAX_TOOL_SESSIONS)} sessions in range are counted.`;
	}
	if (period === 'all') {
		return 'All-time view — the scan is unbounded, so it can be slower than the preset periods.';
	}
	return null;
}
