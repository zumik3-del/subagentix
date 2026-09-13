import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the U1 `?q=` search / LIKE-escaping suite (task #208).
 *
 * The suite exercises the real read-only db + query layer, so it runs in an
 * isolated child `bun test` process (see `data-layer.suite.ts` for the
 * `mock.module('$lib/server/db')` leak rationale). The suite file has no
 * `.test` suffix so the parent glob does not run it in-process.
 *
 * `bun test` writes its report to stderr, and a file filter argument must start
 * with `./` (a bare relative path is treated as a test-name filter).
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const suite = './src/lib/server/queries/search.suite.ts';

test('U1 q-search escaping suite passes in an isolated child process', async () => {
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
