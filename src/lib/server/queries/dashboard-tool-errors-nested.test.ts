import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the tool-errors nested-call suite (task #1501).
 *
 * `health.test.ts` installs a process-wide `mock.module('$lib/server/db', ...)`
 * that bun cannot undo, so the real fixture-DB + query suite runs in an
 * isolated child `bun test` process (pattern from `m4a-tracker.test.ts`).
 *
 * `bun test` writes its report to stderr, and a file filter argument must start
 * with `./` (a bare relative path is treated as a test-name filter).
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

test('tool-errors nested suite passes in an isolated child process', async () => {
	const proc = Bun.spawn(['bun', 'test', './src/lib/server/queries/dashboard-tool-errors-nested.suite.ts'], {
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
