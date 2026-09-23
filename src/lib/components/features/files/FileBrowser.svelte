<script lang="ts">
	/**
	 * `/files` browser root (epic #775, spec §7).
	 *
	 * Owns the single session content loader (§5.3) shared by every row, aborts
	 * in-flight requests on unmount, and renders the block list plus the §7
	 * notice states (DB unavailable, no projects, missing config directory).
	 */
	import type { FileBlock } from '$lib/model/files';
	import { onDestroy } from 'svelte';
	import FileBlockView from './FileBlock.svelte';
	import { createFileContentLoader } from './content';

	interface Props {
		blocks: readonly FileBlock[];
		projectsAvailable: boolean;
	}

	let { blocks, projectsAvailable }: Props = $props();

	const loader = createFileContentLoader();
	onDestroy(() => loader.abort());

	let globalBlock = $derived(blocks.find((block) => block.scope === 'global'));
	let projectCount = $derived(blocks.filter((block) => block.scope === 'project').length);
</script>

<section class="files-browser">
	{#if !projectsAvailable}
		<p class="files-browser__notice" role="status">
			Project list unavailable (opencode DB not reachable).
		</p>
	{:else if projectCount === 0}
		<p class="files-browser__notice" role="status">No opencode projects found.</p>
	{/if}

	{#if globalBlock !== undefined && !globalBlock.available}
		<p class="files-browser__notice" role="status">Config directory not found.</p>
	{/if}

	{#each blocks as block (block.id)}
		<FileBlockView {block} load={loader.load} />
	{/each}
</section>

<style>
	.files-browser {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.files-browser__notice {
		margin: 0;
		padding: var(--space-3) var(--space-4);
		background: var(--surface-base);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-lg);
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}
</style>
