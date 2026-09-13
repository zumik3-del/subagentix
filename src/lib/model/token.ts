/**
 * Pure token arithmetic and UI labels (ADR §7.1). No I/O, no server imports —
 * this module is safe in the browser and in unit tests.
 */
import type { Usage } from './types';

/** The five stored token categories. */
export interface TokenCounts {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Canonical gross total (ADR §1.1): `output` already excludes `reasoning`, so
 * the five categories sum to the total without double counting.
 */
export function total(counts: TokenCounts): number {
	return counts.input + counts.output + counts.reasoning + counts.cacheRead + counts.cacheWrite;
}

/** UI labels; product wording from spec §6. */
export const TOKEN_LABELS = {
	input: 'Input (fresh)',
	output: 'Output (generated)',
	reasoning: 'Reasoning',
	cacheRead: 'Cache read',
	cacheWrite: 'Cache write',
	total: 'Total',
	cost: 'Cost (gross)'
} as const;

export type TokenLabelKey = keyof typeof TOKEN_LABELS;

/** A zeroed {@link Usage}. */
export function emptyUsage(): Usage {
	return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

/** Build a {@link Usage} from stored categories; `total` is always derived. */
export function usageFromCounts(counts: TokenCounts, cost = 0): Usage {
	return {
		input: counts.input,
		output: counts.output,
		reasoning: counts.reasoning,
		cacheRead: counts.cacheRead,
		cacheWrite: counts.cacheWrite,
		total: total(counts),
		cost
	};
}

/** Immutably add two usages (total and cost stay consistent). */
export function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		reasoning: a.reasoning + b.reasoning,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		total: a.total + b.total,
		cost: a.cost + b.cost
	};
}
