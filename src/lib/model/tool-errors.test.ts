import { describe, expect, test } from 'bun:test';
import { clampErrorLimit, clampErrorOffset, DEFAULT_ERROR_LIMIT, MAX_ERROR_LIMIT } from './tool-errors';

describe('clampErrorLimit()', () => {
	test('finite values in range pass through', () => {
		expect(clampErrorLimit(1)).toBe(1);
		expect(clampErrorLimit(50)).toBe(50);
		expect(clampErrorLimit(MAX_ERROR_LIMIT)).toBe(MAX_ERROR_LIMIT);
	});

	test('below 1 clamps to 1', () => {
		expect(clampErrorLimit(0)).toBe(1);
		expect(clampErrorLimit(-5)).toBe(1);
	});

	test('above MAX_ERROR_LIMIT clamps to MAX_ERROR_LIMIT', () => {
		expect(clampErrorLimit(MAX_ERROR_LIMIT + 1)).toBe(MAX_ERROR_LIMIT);
		expect(clampErrorLimit(9999)).toBe(MAX_ERROR_LIMIT);
	});

	test('non-finite values fall back to DEFAULT_ERROR_LIMIT', () => {
		expect(clampErrorLimit(Number.NaN)).toBe(DEFAULT_ERROR_LIMIT);
		expect(clampErrorLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ERROR_LIMIT);
		expect(clampErrorLimit(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_ERROR_LIMIT);
	});

	test('float values are floored', () => {
		expect(clampErrorLimit(50.9)).toBe(50);
		expect(clampErrorLimit(1.1)).toBe(1);
	});
});

describe('clampErrorOffset()', () => {
	test('finite non-negative values pass through', () => {
		expect(clampErrorOffset(0)).toBe(0);
		expect(clampErrorOffset(10)).toBe(10);
		expect(clampErrorOffset(9999)).toBe(9999);
	});

	test('negative values clamp to 0', () => {
		expect(clampErrorOffset(-1)).toBe(0);
		expect(clampErrorOffset(-100)).toBe(0);
	});

	test('non-finite values fall back to 0', () => {
		expect(clampErrorOffset(Number.NaN)).toBe(0);
		expect(clampErrorOffset(Number.POSITIVE_INFINITY)).toBe(0);
		expect(clampErrorOffset(Number.NEGATIVE_INFINITY)).toBe(0);
	});

	test('float values are floored', () => {
		expect(clampErrorOffset(10.9)).toBe(10);
	});
});

describe('DEFAULT_ERROR_LIMIT / MAX_ERROR_LIMIT constants', () => {
	test('defaults have expected values', () => {
		expect(DEFAULT_ERROR_LIMIT).toBe(50);
		expect(MAX_ERROR_LIMIT).toBe(200);
	});
});
