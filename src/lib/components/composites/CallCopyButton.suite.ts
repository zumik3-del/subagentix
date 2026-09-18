/**
 * SSR render suite for CallCopyButton (task #541).
 *
 * Pins the rendered structure: the copy icon by default, aria-label with the
 * call name, and no clipboard API call at SSR time. SSR cannot exercise the
 * click path or the 1.5 s reset timer, so that behaviour is noted explicitly.
 * No DOM runtime, no DB. Uses Vite's SSR module runner.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type ViteDevServer } from 'vite';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let CallCopyButton: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;
	CallCopyButton = (
		(await vite.ssrLoadModule(
			'/src/lib/components/composites/CallCopyButton.svelte'
		)) as { default: unknown }
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

function normalizeHtml(html: string): string {
	return html
		.replace(/<!--\[-->/g, '')
		.replace(/<!--[-1]-->/g, '')
		.replace(/<!--\[0-->/g, '')
		.replace(/<!--]-->/g, '')
		.replace(/\bsvelte-[a-z0-9]+/g, '')
		.replace(/class="([^"]*)"/g, (_m, v) => `class="${v.trim()}"`)
		.replace(/\s+/g, ' ')
		.trim();
}

function makeCall(
	overrides: Partial<{ id: string; name: string; isMcp: boolean; isDelegation: boolean }> = {}
) {
	return {
		id: 'c1',
		name: 'bash',
		isMcp: false,
		isDelegation: false,
		...overrides
	};
}

function renderButton(props: Record<string, unknown> = {}): string {
	return render(CallCopyButton, { props: { call: makeCall(), ...props } }).body;
}

// --- SSR structure: copy icon + aria ------------------------------------------

describe('CallCopyButton — SSR structure', () => {
	test('renders a <button> with the copy class', () => {
		const normalized = normalizeHtml(renderButton());
		expect(normalized).toContain('<button');
		expect(normalized).toContain('ui-icon-btn copy');
	});

	test('default aria-label embeds the call name', () => {
		const html = renderButton({ call: makeCall({ name: 'read-file' }) });
		expect(html).toContain('aria-label="Copy read-file call"');
	});

	test('aria-label uses the actual name prop, not a placeholder', () => {
		const html = renderButton({ call: makeCall({ name: 'grep' }) });
		expect(html).toContain('Copy grep call');
		expect(html).not.toContain('Copy bash call');
	});

	test('no check icon is present at SSR (copied state is client-only)', () => {
		// The check icon only renders when `copied` is true, which requires a
		// successful clipboard write on the client. SSR always sees copied=false.
		const html = renderButton();
		expect(html).not.toMatch(/>check</);
	});
});

// --- Clipboard / click path: explicitly not exercisable from SSR --------------

describe('CallCopyButton — click feedback (SSR limitation)', () => {
	test('the 1.5 s copied→unchecked reset is not SSR-exercisable', () => {
		// SSR cannot dispatch clicks, cannot call navigator.clipboard, and cannot
		// advance timers. The `copy()` handler and the setTimeout reset live in
		// the client lifecycle only. This test documents that limitation rather
		// than asserting an unattainable behaviour.
		const html = renderButton();
		// Default state: copy icon is present, not the check icon.
		expect(html).toContain('ui-icon-btn copy');
		expect(html).not.toMatch(/Copied to clipboard/);
		expect(html).not.toMatch(/sr-only.*Copied/);
	});
});
