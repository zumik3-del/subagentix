import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the top-tools table + tool-errors modal SSR render suite (task #481).
 *
 * Pins the rendered structure of TopToolsTable (button vs span for errors cell)
 * and ToolErrorsModal (overlay skeleton) via Vite's SSR module runner. No DOM
 * runtime, no DB.
 */
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const suite = './src/lib/components/features/dashboard/top-tools-table.suite.ts';

test('top-tools table + tool-errors modal SSR suite passes in an isolated child process', async () => {
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
