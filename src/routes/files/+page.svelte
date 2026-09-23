<script lang="ts">
	/**
	 * `/files` page (epic #775, spec T3): the global opencode config plus one
	 * block per opencode project, with on-demand file contents.
	 *
	 * The loader (`+page.server.ts`) ships only the metadata listing; the browser
	 * fetches bodies per row through `/api/files/content`.
	 */
	import type { PageProps } from './$types';
	import FileBrowser from '$lib/components/features/files/FileBrowser.svelte';

	let { data }: PageProps = $props();
</script>

<main class="files-page">
	<header class="files-page__header">
		<h1 class="files-page__title">Files</h1>
		<a class="ui-link-btn files-page__back" href="/">← Dashboard</a>
	</header>

	<FileBrowser blocks={data.blocks} projectsAvailable={data.projectsAvailable} />
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

	/* `ui-link-btn` is action-styled; as an anchor it needs the underline off. */
	.files-page__back {
		text-decoration: none;
	}
</style>
