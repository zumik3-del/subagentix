import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Wrapper for the SessionOverview suite (tasks #535/#536).
 *
 * Runs the SSR-rendered component tests in an isolated child process so the
 * Vite module graph is fresh and doesn't leak into the parent runner.
 */
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const suite = join(repoRoot, 'src', 'lib', 'components', 'features', 'session', 'SessionOverview.suite.ts');

test('SessionOverview SSR suite passes in an isolated child process', async () => {
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
}, 120_000);
