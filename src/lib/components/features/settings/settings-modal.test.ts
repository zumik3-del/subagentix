import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the SettingsModal SSR render suite (header-X / actions-only footer #501).
 */
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const suite = './src/lib/components/features/settings/settings-modal.suite.ts';

test('SettingsModal SSR suite passes in an isolated child process', async () => {
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
