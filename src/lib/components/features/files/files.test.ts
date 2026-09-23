import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the files UI/component suite (task #781, epic #775).
 *
 * The suite loads client components through Vite's SSR module runner and
 * runs direct unit tests against `content.ts`, so it executes in an isolated
 * child `bun test` process to keep the Vite server and its module graph out
 * of the parent run.
 */
const repoRoot = fileURLToPath(new URL('../../../../..', import.meta.url));
const suite = './src/lib/components/features/files/files.suite.ts';

test('files UI suite passes in an isolated child process', async () => {
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
