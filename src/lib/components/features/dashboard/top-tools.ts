/**
 * Pure view logic for the top-tools widget (dashboard Phase 4, task #413).
 *
 * Kept out of the Svelte body so the count/error-share mapping and the
 * capped-note decision are testable without a renderer or a DOM, mirroring the
 * `data.svelte.ts` helper split. No DOM, no Svelte and no `$lib/server` import.
 */
import { MAX_TOOL_SESSIONS, type DashboardPeriod, type ToolUsage } from '$lib/model/dashboard';
import { formatNumber } from '$lib/model/format';

/** One table row for the top-tools widget. */
export interface TopToolRow {
	/** Tool name. */
	name: string;
	/** Call count. */
	count: number;
	/** Errored calls, rendered in the dedicated errors column. */
	errors: number;
	/** Tooltip with the exact error count and share. */
	title: string;
}

/** Share of a tool's calls that errored, as a rounded percent, e.g. `12%`. */
export function errorPercent(share: number): string {
	const percent = Number.isFinite(share) ? Math.round(share * 100) : 0;
	return `${percent}%`;
}

/**
 * Map the Tier-P rows onto table rows, preserving the server's rank order
 * (count desc, name asc). The tooltip carries the error share; the errors
 * column carries the raw errored-call count.
 */
export function topToolRows(usage: ToolUsage): TopToolRow[] {
	return usage.tools.map((tool) => ({
		name: tool.name,
		count: tool.count,
		errors: tool.errors,
		title: `${formatNumber(tool.errors)} of ${formatNumber(tool.count)} calls errored (${errorPercent(tool.errorShare)})`
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
