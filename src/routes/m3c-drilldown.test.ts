import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the M3c drill-down render suite (task #196).
 *
 * The suite loads the client components through Vite's SSR module runner and
 * renders them with `svelte/server`; it runs in an isolated child `bun test`
 * process so the Vite server and its module graph stay out of the parent run.
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const suite = './src/routes/m3c-drilldown.suite.ts';

test('M3c drill-down render suite passes in an isolated child process', async () => {
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
