import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the Phase 3 regression suite (task #391).
 *
 * `health.test.ts` installs a process-wide `mock.module('$lib/server/db', ...)`
 * and bun's `mock.module` cannot be undone, so the real read-only db + query +
 * service suite runs in an isolated child `bun test` process. The suite file is
 * `phase3-regression.suite.ts` (no `.test` suffix) so the parent glob does not
 * pick it up.
 *
 * `bun test` writes its report to stderr, and a file filter argument must start
 * with `./` (a bare relative path is treated as a test-name filter).
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('Phase 3 regression suite passes in an isolated child process', async () => {
	const proc = Bun.spawn(['bun', 'test', './src/lib/server/phase3-regression.suite.ts'], {
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
}, 30_000);
