import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the dashboard cache regression suite (task #408).
 *
 * The suite exercises the cache module against a throwaway fixture DB, so it
 * runs in an isolated child `bun test` process to avoid polluting the parent
 * test runner's module graph.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const suite = './src/lib/server/services/dashboard-cache.suite.ts';

test('dashboard cache suite passes in an isolated child process', async () => {
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
}, 30_000);
