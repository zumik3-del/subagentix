<script lang="ts">
	/**
	 * One tool input/output/content block (extracted from `NodeDetailPanel`,
	 * ADR 2.3).
	 *
	 * Dedupes the three label + `ScrollView` + expand-toggle patterns: the
	 * `.io` wrapper, the uppercase label, the vertical `ScrollView` and the
	 * borderless expand/collapse icon button. Pure presentation — the panel
	 * root owns the `expanded` record and passes the value decision through
	 * the `children` snippet plus the truncation metadata and the `onToggle`
	 * callback.
	 *
	 * The action-content toggle historically dropped the label word from its
	 * aria/title text; that is preserved verbatim for parity.
	 */
	import type { Snippet } from 'svelte';
	import { formatNumber } from '$lib/model/format';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import ScrollView from '$lib/components/primitives/ScrollView.svelte';

	interface Props {
		/** Visible label; also names the expand control for input/output. */
		label: string;
		/** Whether the full value is currently shown. */
		expanded: boolean;
		/** Whether the value is truncated (so the toggle is offered). */
		truncated: boolean;
		/** Character length of the full value (shown in the toggle tooltip). */
		originalLength: number;
		/** Toggle the expanded state for this block (state stays in the panel). */
		onToggle: () => void;
		/** The value to display: full when expanded, truncated otherwise. */
		children: Snippet;
	}

	let { label, expanded, truncated, originalLength, onToggle, children }: Props = $props();

	/** Expand/collapse verb + label word + original length (see header note). */
	const toggleText = $derived(
		`${expanded ? 'Collapse' : 'Expand'}${label === 'content' ? '' : ` ${label}`} (${formatNumber(originalLength)} chars)`
	);
</script>

<div class="io">
	<span class="io-label">{label}</span>
	<div class="io-text">
		<ScrollView>{@render children()}</ScrollView>
	</div>
	{#if truncated}
		<button
			type="button"
			class="io-toggle"
			aria-expanded={expanded}
			aria-label={toggleText}
			title={toggleText}
			onclick={onToggle}
		>
			<Icon name={expanded ? 'collapse' : 'expand'} size={14} />
		</button>
	{/if}
</div>

<style>
	.io {
		margin-top: var(--space-1);
	}

	.io-label {
		color: var(--text-weak);
		font-size: var(--font-size-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	/* Borderless expand/collapse icon control under a truncated block. */
	.io-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		margin-top: var(--space-1);
		padding: 0;
		background: none;
		border: none;
		color: var(--text-interactive-base);
		cursor: pointer;
	}

	.io-toggle:hover {
		color: var(--text-strong);
	}

	.io-text {
		display: flex;
		flex-direction: column;
		margin: var(--space-1) 0 0;
		padding: var(--space-2);
		background: var(--background-strong);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
		font-family: var(--font-family-mono);
		font-size: var(--font-size-sm);
		color: var(--text-base);
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 16rem;
		overflow: hidden;
	}
</style>
