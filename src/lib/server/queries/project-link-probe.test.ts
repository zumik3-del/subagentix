import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the projectLink probe invalidation suite (task #359, issue #4).
 *
 * The suite opens real fixture DBs through `$lib/server/db`, so it runs in an
 * isolated child `bun test` process (same `mock.module` leak rationale as
 * `directories.suite.ts` / `search.suite.ts`).
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const suite = './src/lib/server/queries/project-link-probe.suite.ts';

test('projectLink probe invalidation suite passes in an isolated child process', async () => {
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
