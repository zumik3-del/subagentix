import { describe, expect, test } from 'bun:test';
import {
	addUsage,
	emptyUsage,
	TOKEN_LABELS,
	total,
	usageFromCounts,
	type TokenCounts
} from './token';

/**
 * Unit tests for the pure token arithmetic (task #185, ADR §1.1 / §8).
 *
 * No DB, no server imports: `token.ts` is the canonical gross-total helper, and
 * these assertions pin the "output excludes reasoning" correction and the
 * "cost = 0 means unmetered, never missing" rule.
 */

const FIVE: TokenCounts = {
	input: 100,
	output: 50,
	reasoning: 20,
	cacheRead: 10,
	cacheWrite: 5
};

describe('total()', () => {
	test('equals input + output + reasoning + cacheRead + cacheWrite', () => {
		expect(total(FIVE)).toBe(185);
	});

	test('output already excludes reasoning, so reasoning is added once (no double count)', () => {
		// ADR §1.1: `output` is generated tokens *excluding* thinking. A row with
		// more reasoning than output (5,769 such rows live) must still sum both.
		expect(total({ input: 0, output: 5, reasoning: 100, cacheRead: 0, cacheWrite: 0 })).toBe(105);
	});

	test('is 0 for an all-zero set', () => {
		expect(total({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
	});

	test('is independent of cost (cost is not a token category)', () => {
		const counts: TokenCounts = { ...FIVE };
		expect(total(counts)).toBe(185);
		expect(Object.keys(counts)).not.toContain('cost');
	});
});

describe('usageFromCounts()', () => {
	test('derives total and defaults cost to 0', () => {
		expect(usageFromCounts(FIVE)).toEqual({ ...FIVE, total: 185, cost: 0 });
	});

	test('cost = 0 is preserved as 0 (unmetered), never null/undefined', () => {
		const usage = usageFromCounts(FIVE, 0);
		expect(usage.cost).toBe(0);
		expect(usage.cost).not.toBeNull();
		expect(usage.cost).not.toBeUndefined();
		// Rendering `0`/unmetered must not change the token total.
		expect(usage.total).toBe(185);
	});

	test('passes a non-zero cost through unchanged', () => {
		expect(usageFromCounts(FIVE, 1.25).cost).toBe(1.25);
	});
});

describe('addUsage()', () => {
	test('adds each category, total and cost immutably', () => {
		const a = usageFromCounts(FIVE, 1);
		const b = usageFromCounts({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }, 0.5);
		const sum = addUsage(a, b);
		expect(sum).toEqual({
			input: 101,
			output: 52,
			reasoning: 23,
			cacheRead: 14,
			cacheWrite: 10,
			total: 200,
			cost: 1.5
		});
		// Originals untouched.
		expect(a.total).toBe(185);
		expect(b.total).toBe(15);
	});

	test('summing with emptyUsage() is the identity', () => {
		expect(addUsage(emptyUsage(), usageFromCounts(FIVE))).toEqual(usageFromCounts(FIVE));
	});
});

describe('labels', () => {
	test('exposes the five categories plus total and gross cost', () => {
		expect(TOKEN_LABELS.output).toBe('Output (generated)');
		expect(TOKEN_LABELS.input).toBe('Input (fresh)');
		expect(TOKEN_LABELS.cacheRead).toBe('Cache read');
		expect(TOKEN_LABELS.cacheWrite).toBe('Cache write');
		expect(TOKEN_LABELS.total).toBe('Total');
		expect(TOKEN_LABELS.cost).toBe('Cost (gross)');
	});
});
