<script lang="ts">
	/**
	 * `/files` page (epic #775, spec T3; task #786): the global opencode config
	 * plus one block per opencode project, with on-demand file contents.
	 *
	 * The loader (`+page.server.ts`) ships only the metadata listing; the browser
	 * fetches bodies per row through `/api/files/content`. This page owns the
	 * listing state and the shared content loader so the header Reload control can
	 * re-read both: it re-fetches `GET /api/files` with `cache: 'no-store'`,
	 * resets the content cache (aborting in-flight reads) and remounts the browser
	 * through `{#key}` so every row re-reads its content on the next expand. A
	 * failed reload keeps the previous listing and reports inline.
	 */
	import type { PageProps } from './$types';
	import type { FileIndex } from '$lib/model/files';
	import { onDestroy } from 'svelte';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import FileBrowser from '$lib/components/features/files/FileBrowser.svelte';
	import { createFileContentLoader, fetchFileIndex } from '$lib/components/features/files/content';

	let { data }: PageProps = $props();

	// Reloaded listing, or `null` while the loader's listing is current. The
	// derived view falls back to the loader data, so a failed reload keeps it.
	let applied = $state<FileIndex | null>(null);
	const blocks = $derived(applied?.blocks ?? data.blocks);
	const projectsAvailable = $derived(applied?.projectsAvailable ?? data.projectsAvailable);
	let reloading = $state(false);
	let reloadError = $state<string | null>(null);
	// Bumped only on a successful reload; the keyed browser remounts so every row
	// drops its content and re-reads on expand.
	let reloadToken = $state(0);

	const loader = createFileContentLoader();
	onDestroy(() => loader.abort());

	async function reload(): Promise<void> {
		if (reloading) return;
		reloading = true;
		reloadError = null;
		try {
			const index = await fetchFileIndex();
			loader.reset();
			applied = index;
			reloadToken += 1;
		} catch (cause) {
			// Keep the previous listing; only surface the failure.
			reloadError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			reloading = false;
		}
	}
</script>

<main class="files-page">
	<header class="files-page__header">
		<h1 class="files-page__title">Files</h1>
		<div class="files-page__actions">
			<button
				type="button"
				class="ui-btn"
				onclick={() => void reload()}
				disabled={reloading}
				aria-busy={reloading}
			>
				<Icon name="refresh" />
				Reload
			</button>
			<a class="ui-link-btn files-page__back" href="/">← Dashboard</a>
		</div>
	</header>

	{#if reloadError !== null}
		<p class="files-page__error" role="alert">{reloadError}</p>
	{/if}

	{#key reloadToken}
		<FileBrowser {blocks} {projectsAvailable} load={loader.load} />
	{/key}
</main>

<style>
	.files-page {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
		padding: var(--space-6) var(--space-4) var(--space-12);
	}

	.files-page__header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-4);
	}

	.files-page__title {
		margin: 0;
		font-size: var(--font-size-x-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.files-page__actions {
		display: flex;
		align-items: center;
		gap: var(--space-4);
	}

	.files-page__error {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		color: var(--color-danger-strong);
		background: var(--color-danger-surface);
		border: 1px solid var(--color-danger-border);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-small);
	}

	/* `ui-link-btn` is action-styled; as an anchor it needs the underline off. */
	.files-page__back {
		text-decoration: none;
	}
</style>
