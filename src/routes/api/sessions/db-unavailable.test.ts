import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the M3a DB-unavailable suite (task #188). The suite points
 * `OPENCODE_DB` at a missing file and must run with a clean `$lib/server/db`
 * import, so it executes in an isolated child `bun test` process.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const suite = './src/routes/api/sessions/db-unavailable.suite.ts';

test('M3a DB-unavailable suite passes in an isolated child process', async () => {
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
