import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the U2 sidebar directories suite (task #213).
 *
 * The suite opens a real fixture DB through `$lib/server/db`, and
 * `health.test.ts` installs a process-wide `mock.module('$lib/server/db', ...)`
 * that bun cannot undo, so it runs in an isolated child `bun test` process. The
 * suite file is `directories.suite.ts` (no `.test` suffix) so the parent glob
 * does not pick it up.
 *
 * `bun test` writes its report to stderr, and a file filter argument must start
 * with `./` (a bare relative path is treated as a test-name filter).
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const suite = './src/lib/server/queries/directories.suite.ts';

test('U2 directories suite passes in an isolated child process', async () => {
	const proc = Bun.spawn(['bun', 'test', suite], {
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
