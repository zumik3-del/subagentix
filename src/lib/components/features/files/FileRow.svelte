<script lang="ts">
	/**
	 * One file row on `/files` (epic #775, spec §7).
	 *
	 * A `<button aria-expanded>` toggle; the first expand asks the shared loader
	 * for the content (cached per `block|path`, §5.3) and the content region
	 * renders the §7 states: loading, text in a `ScrollView` `<pre>`, the binary
	 * notice, or an inline `role="alert"` error (retryable). Collapsing keeps the
	 * loaded content so a re-expand does not re-fetch.
	 */
	import type { FileContent, FileRef } from '$lib/model/files';
	import ScrollView from '$lib/components/primitives/ScrollView.svelte';
	import TreeIcon from '$lib/components/primitives/TreeIcon.svelte';
	import { formatBytes } from './format';

	interface Props {
		file: FileRef;
		/** Owning block id, passed straight to the content API. */
		blockId: string;
		/** Shared session loader (one fetch per `block|path`). */
		load: (block: string, path: string) => Promise<FileContent>;
	}

	let { file, blockId, load }: Props = $props();

	let open = $state(false);
	let loading = $state(false);
	let content = $state<FileContent | null>(null);
	let error = $state<string | null>(null);

	// Stable ids for `aria-controls`; block ids contain `:` and paths `/`, so
	// they are flattened to the id-safe alphabet.
	function idSafe(value: string): string {
		return value.replace(/[^a-zA-Z0-9_-]/g, '-');
	}

	let contentId = $derived(`files-content-${idSafe(blockId)}-${idSafe(file.path)}`);

	// `key: value` pairs joined by ` · `; `null` when the file carries no meta.
	let metaText = $derived(
		file.meta === undefined || file.meta.length === 0
			? null
			: file.meta.map((field) => `${field.label}: ${field.value}`).join(' · ')
	);

	async function toggle(): Promise<void> {
		if (open) {
			open = false;
			return;
		}
		open = true;
		// Already loaded (or loading): reuse — never a second fetch.
		if (content !== null || loading) return;
		loading = true;
		error = null;
		try {
			content = await load(blockId, file.path);
		} catch (cause) {
			// An aborted request (page unmount) is not an error state.
			if (cause instanceof DOMException && cause.name === 'AbortError') return;
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			loading = false;
		}
	}
</script>

<li class="files-row" title={file.path}>
	<button
		type="button"
		class="files-row__toggle"
		aria-expanded={open}
		aria-controls={contentId}
		onclick={() => {
			void toggle();
		}}
	>
		<TreeIcon name="chevron" expanded={open} size={14} />
		<span class="files-row__name">{file.displayName ?? file.name}</span>
		{#if metaText !== null}
			<span class="files-row__meta">{metaText}</span>
		{/if}
		<span class="files-row__size">{formatBytes(file.size)}</span>
	</button>

	<!-- The panel stays mounted (so `aria-controls` resolves); a collapsed row
	     renders no content. -->
	<div id={contentId} class="files-row__content" class:files-row__content--open={open}>
		{#if open}
			{#if loading}
				<p class="files-row__status muted" role="status">Loading…</p>
			{:else if error !== null}
				<p class="files-row__error" role="alert">{error}</p>
			{:else if content?.binary}
				<p class="files-row__status muted">Binary file — not displayed.</p>
			{:else if content !== null}
				<div class="files-row__scroll">
					<ScrollView orientation="both">
						<pre class="files-row__pre">{content.content}</pre>
					</ScrollView>
				</div>
			{/if}
		{/if}
	</div>
</li>

<style>
	.files-row {
		list-style: none;
		border-top: 1px solid var(--border-weaker-base);
	}

	.files-row__toggle {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		padding: var(--space-2) var(--space-1);
		background: none;
		border: none;
		color: var(--text-base);
		font: inherit;
		font-size: var(--font-size-small);
		text-align: left;
		cursor: pointer;
	}

	.files-row__toggle:hover {
		background: var(--surface-base-hover);
		color: var(--text-strong);
	}

	.files-row__name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-family-mono);
	}

	.files-row__meta {
		min-width: 0;
		flex: 0 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-family-mono);
		font-size: var(--font-size-xs);
		color: var(--text-weak);
	}

	.files-row__size {
		margin-left: auto;
		flex: none;
		font-variant-numeric: tabular-nums;
		color: var(--text-weak);
	}

	.files-row__content--open {
		padding: 0 var(--space-1) var(--space-3);
	}

	.files-row__status {
		margin: 0;
		font-size: var(--font-size-small);
	}

	.files-row__error {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		color: var(--color-danger-strong);
		background: var(--color-danger-surface);
		border: 1px solid var(--color-danger-border);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-small);
	}

	.files-row__scroll {
		display: flex;
		max-height: 24rem;
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
		background: var(--background-strong);
	}

	.files-row__pre {
		margin: 0;
		padding: var(--space-3);
		font-family: var(--font-family-mono);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-large);
		color: var(--text-base);
		white-space: pre;
	}
</style>
