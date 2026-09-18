<script lang="ts">
	/**
	 * Self-contained "copy this record" button (task #541).
	 *
	 * Extracted from `ToolCallDetail` so that card stays under the component
	 * line budget. Owns its own `copied` state and reset timer: the click
	 * handler writes the full text dump (via `formatToolCallText`) to the
	 * clipboard, flips the icon to a check for ~1.5s and clears the timer on
	 * destroy. The clipboard call lives only inside the handler, so SSR never
	 * touches it. An absolute position lets the host card anchor the button at
	 * its top-right (`position: relative` on the host root).
	 */
	import { onDestroy } from 'svelte';
	import { clock } from '$lib/model/clock.svelte';
	import { formatToolCallText, type ToolCallTextInput } from '$lib/model/node';
	import Icon from '$lib/components/primitives/Icon.svelte';

	interface Props {
		/** The record to dump; supplies the `aria-label` name and copy text. */
		call: ToolCallTextInput;
	}

	let { call }: Props = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	/** Copy the call's full text dump; show a brief "copied" state or fail silently. */
	async function copy() {
		try {
			await navigator.clipboard.writeText(formatToolCallText(call, clock.tz));
			copied = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				copied = false;
				timer = null;
			}, 1500);
		} catch {
			copied = false;
		}
	}

	onDestroy(() => {
		if (timer) clearTimeout(timer);
	});
</script>

<button
	type="button"
	class="ui-icon-btn copy"
	aria-label={copied ? 'Copied to clipboard' : `Copy ${call.name} call`}
	onclick={copy}
>
	{#if copied}
		<Icon name="check" size={14} />
		<span class="sr-only" role="status">Copied</span>
	{:else}
		<Icon name="copy" size={14} />
	{/if}
</button>

<style>
	.copy {
		position: absolute;
		top: var(--space-1);
		right: var(--space-1);
	}
</style>
