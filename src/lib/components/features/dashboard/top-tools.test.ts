import { describe, expect, test } from 'bun:test';
import { errorShareLabel, topToolBars, topToolsNote } from './top-tools';
import { MAX_TOOL_SESSIONS } from '$lib/model/dashboard';
import type { ToolUsage } from '$lib/model/dashboard';

/**
 * Unit tests for the pure top-tools view logic (dashboard Phase 4, task #413).
 *
 * Kept in a plain `.ts` module so the count/error-share mapping and the capped
 * note decision are testable without a renderer or a DOM — mirroring the
 * `top-tools.ts` split (docs/ui-standards.md §10).
 */

describe('errorShareLabel()', () => {
	test('rounds a finite share to a percent label', () => {
		expect(errorShareLabel(0.125)).toBe('13% errors');
		expect(errorShareLabel(0.5)).toBe('50% errors');
		expect(errorShareLabel(0.999)).toBe('100% errors');
	});

	test('treats zero as 0%', () => {
		expect(errorShareLabel(0)).toBe('0% errors');
	});

	test('NaN / Infinity degrade to 0%', () => {
		expect(errorShareLabel(Number.NaN)).toBe('0% errors');
		expect(errorShareLabel(Number.POSITIVE_INFINITY)).toBe('0% errors');
		expect(errorShareLabel(Number.NEGATIVE_INFINITY)).toBe('0% errors');
	});

	test('negative shares still round to a percent (no clamping)', () => {
		expect(errorShareLabel(-0.1)).toBe('-10% errors');
	});
});

describe('topToolBars()', () => {
	const makeUsage = (tools: ToolUsage['tools']): ToolUsage => ({ tools, capped: false });

	test('maps each tool onto a BarChart row with value, detail and title', () => {
		const usage = makeUsage([
			{ name: 'bash', count: 100, errors: 10, errorShare: 0.1 },
			{ name: 'read', count: 50, errors: 0, errorShare: 0 }
		]);
		const bars = topToolBars(usage);
		expect(bars).toHaveLength(2);
		expect(bars[0]).toEqual({
			label: 'bash',
			value: 100,
			title: '10 of 100 calls errored',
			detail: '10% errors'
		});
		expect(bars[1]).toEqual({
			label: 'read',
			value: 50,
			title: '0 of 50 calls errored',
			detail: '0% errors'
		});
	});

	test('preserves server rank order (input order is kept)', () => {
		const usage = makeUsage([
			{ name: 'b', count: 100, errors: 5, errorShare: 0.05 },
			{ name: 'a', count: 100, errors: 2, errorShare: 0.02 },
			{ name: 'c', count: 50, errors: 0, errorShare: 0 }
		]);
		const bars = topToolBars(usage);
		// topToolBars preserves the input array order (server returns ranked).
		expect(bars.map((b) => b.label)).toEqual(['b', 'a', 'c']);
	});

	test('empty tools yields no bars', () => {
		expect(topToolBars({ tools: [], capped: false })).toEqual([]);
	});
});

describe('topToolsNote()', () => {
	const base: ToolUsage = { tools: [], capped: false };

	test('null when not capped and period is bounded', () => {
		expect(topToolsNote(base, '7d')).toBeNull();
		expect(topToolsNote(base, '30d')).toBeNull();
		expect(topToolsNote(base, '90d')).toBeNull();
	});

	test('capped note explains the Tier-P ceiling regardless of period', () => {
		const capped = { ...base, capped: true };
		const note = topToolsNote(capped, '30d');
		expect(note).toBe(
			`Approximate — only the most recent ${MAX_TOOL_SESSIONS.toLocaleString('en-US')} sessions in range are counted.`
		);
	});

	test('period=all note explains the unbounded slow path', () => {
		const uncapped = { ...base, capped: false };
		expect(topToolsNote(uncapped, 'all')).toBe(
			'All-time view — the scan is unbounded, so it can be slower than the preset periods.'
		);
	});

	test('capped takes priority over period=all', () => {
		const note = topToolsNote({ ...base, capped: true }, 'all');
		expect(note).toContain('Approximate');
		expect(note).not.toContain('unbounded');
	});
});

/**
 * Verify top-tools.ts stays DOM-free and server-free (spec §2.1 contract).
 */
describe('top-tools.ts stays DOM-free and server-free', () => {
	test('does not import $lib/server, Svelte or the DOM', async () => {
		const source = new URL('./top-tools.ts', import.meta.url);
		const content = await Bun.file(source).text();
		expect(content).not.toMatch(/from ['"]\$lib\/server/);
		expect(content).not.toMatch(/from ['"]svelte/);
		expect(content).not.toMatch(/\bdocument\.|\bwindow\./);
	});
});
