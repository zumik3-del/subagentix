import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the M4a tracker-reference resolver suite (task #199).
 *
 * `health.test.ts` installs a process-wide `mock.module('$lib/server/db', ...)`
 * that bun cannot undo, so the real fixture-DB + turn-service suite runs in an
 * isolated child `bun test` process (pattern from `data-layer.test.ts`).
 *
 * `bun test` writes its report to stderr, and a file filter argument must start
 * with `./` (a bare relative path is treated as a test-name filter).
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('M4a tracker resolver suite passes in an isolated child process', async () => {
	const proc = Bun.spawn(['bun', 'test', './src/lib/server/m4a-tracker.suite.ts'], {
		cwd: repoRoot,
		env: process.env,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	const report = `${stdout}\n${stderr}`;
	if (exitCode !== 0) console.error(report);

	expect(report).toContain('0 fail');
	expect(report).toMatch(/[1-9]\d* pass/);
	expect(exitCode).toBe(0);
});
