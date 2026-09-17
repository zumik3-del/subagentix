import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Source-guard tests for the shared CSS primitives in src/app.css.
 *
 * Verifies that the --control-height token and .ui-select / .ui-input
 * primitives are defined consistently and that call sites adopt them
 * without re-implementing the control box. (Tasks #505–#506.)
 */

const css = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');

describe('--control-height token', () => {
	test('is declared in :root with value 2rem', () => {
		const rootIdx = css.indexOf(':root {');
		expect(rootIdx).toBeGreaterThan(-1);
		let depth = 0;
		let end = -1;
		for (let i = rootIdx; i < css.length; i++) {
			if (css[i] === '{') depth++;
			else if (css[i] === '}') {
				depth--;
				if (depth === 0) { end = i; break; }
			}
		}
		expect(end).toBeGreaterThan(-1);
		const rootBlock = css.slice(rootIdx, end + 1);
		expect(rootBlock).toMatch(/--control-height:\s*2rem\s*;?/);
	});
});

describe('.ui-input primitive', () => {
	test('uses height from --control-height', () => {
		const block = css.match(/\.ui-input\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block).toContain('height: var(--control-height)');
	});

	test('uses shared box tokens (background, border, radius, padding, font)', () => {
		const block = css.match(/\.ui-input\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block).toContain('padding: 0 var(--space-2)');
		expect(block).toContain('background: var(--surface-base)');
		expect(block).toContain('border: 1px solid var(--border-weak-base)');
		expect(block).toContain('border-radius: var(--radius-sm)');
		expect(block).toContain('font: inherit');
		expect(block).toContain('font-size: var(--font-size-small)');
		expect(block).toContain('line-height: 1');
	});

	test('sets text color to --text-strong', () => {
		const block = css.match(/\.ui-input\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block).toContain('color: var(--text-strong)');
	});

	test('placeholder uses --text-weak via ::placeholder', () => {
		const block = css.match(/\.ui-input::placeholder\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block).toContain('color: var(--text-weak)');
	});
});

describe('.ui-select primitive', () => {
	test('uses height from --control-height', () => {
		const block = css.match(/\.ui-select\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block).toContain('height: var(--control-height)');
	});

	test('shares the same box properties as .ui-input', () => {
		const inputBlock = css.match(/\.ui-input\s*\{[^}]*\}/)?.[0] ?? '';
		const selectBlock = css.match(/\.ui-select\s*\{[^}]*\}/)?.[0] ?? '';

		// Height, padding, background, border, radius, font, font-size, line-height
		// must match between the two — they own the same control box.
		const sharedProps = [
			'height: var(--control-height)',
			'padding: 0 var(--space-2)',
			'background: var(--surface-base)',
			'color: var(--text-strong)',
			'border: 1px solid var(--border-weak-base)',
			'border-radius: var(--radius-sm)',
			'font: inherit',
			'font-size: var(--font-size-small)',
			'line-height: 1',
		];
		for (const prop of sharedProps) {
			expect(selectBlock).toContain(prop);
		}
	});

	test('adds cursor: pointer on top of the shared box', () => {
		const block = css.match(/\.ui-select\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block).toContain('cursor: pointer');
	});

	test('does not restyle the native appearance (arrow)', () => {
		// The spec says "the native arrow is left untouched."
		// If -webkit-appearance / appearance were declared, the arrow would be
		// restyled, which is a regression.
		const block = css.match(/\.ui-select\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block).not.toMatch(/appearance\s*:/);
	});
});

describe('.ui-btn primitive', () => {
	test('uses height from --control-height', () => {
		const block = css.match(/\.ui-btn\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block).toContain('height: var(--control-height)');
	});

	test('shares the same box properties as .ui-input and .ui-select', () => {
		const inputBlock = css.match(/\.ui-input\s*\{[^}]*\}/)?.[0] ?? '';
		const selectBlock = css.match(/\.ui-select\s*\{[^}]*\}/)?.[0] ?? '';
		const btnBlock = css.match(/\.ui-btn\s*\{[^}]*\}/)?.[0] ?? '';

		// Height, padding, background, border, radius, font, font-size, line-height
		// must match across all three — they own the same control box.
		const sharedProps = [
			'height: var(--control-height)',
			'padding: 0 var(--space-2)',
			'background: var(--surface-base)',
			'border: 1px solid var(--border-weak-base)',
			'border-radius: var(--radius-sm)',
			'font: inherit',
			'font-size: var(--font-size-small)',
			'line-height: 1',
		];
		for (const prop of sharedProps) {
			expect(inputBlock).toContain(prop);
			expect(selectBlock).toContain(prop);
			expect(btnBlock).toContain(prop);
		}
	});

	test('is inline-flex with centered content', () => {
		const block = css.match(/\.ui-btn\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block).toContain('display: inline-flex');
		expect(block).toContain('align-items: center');
		expect(block).toContain('justify-content: center');
	});
});

describe('.ui-icon-btn is excluded from --control-height', () => {
	test('uses --space-6, not --control-height, for its size', () => {
		const block = css.match(/\.ui-icon-btn\s*\{[^}]*\}/)?.[0] ?? '';
		expect(block).toContain('width: var(--space-6)');
		expect(block).toContain('height: var(--space-6)');
		expect(block).not.toContain('height: var(--control-height)');
	});
});

describe('Call-site adoption of .ui-select', () => {
	const components = [
		{ name: 'ToolErrorsModal', path: './features/dashboard/ToolErrorsModal.svelte' },
		{ name: 'FilterSelector', path: './features/dashboard/FilterSelector.svelte' },
		{ name: 'WidgetSettings', path: './features/dashboard/WidgetSettings.svelte' },
	];

	for (const comp of components) {
		const source = readFileSync(
			new URL(`./features/dashboard/${comp.name}.svelte`, import.meta.url),
			'utf8'
		);

		test(`${comp.name} uses .ui-select on <select> elements`, () => {
			expect(source).toMatch(/class="[^"]*ui-select[^"]*"/);
		});

		test(`${comp.name} does not redeclare control-height in its own styles`, () => {
			// Each component may add width-only locals; it must not re-declare
			// height, padding, border or background that overlap the .ui-select box.
			const styleMatch = source.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [];
			for (const styleBlock of styleMatch) {
				// Allow width-only rules; reject height/padding/border re-declarations
				// on the select class.
				expect(styleBlock).not.toMatch(/\.?\w*select[^{]*\{[^}]*height\s*:/);
				expect(styleBlock).not.toMatch(/\.?\w*select[^{]*\{[^}]*padding\s*:/);
				expect(styleBlock).not.toMatch(/\.?\w*select[^{]*\{[^}]*border\s*:/);
				expect(styleBlock).not.toMatch(/\.?\w*select[^{]*\{[^}]*background\s*:/);
			}
		});
	}
});
