<script lang="ts">
	/**
	 * `/files` browser root (epic #775, spec §7; task #786).
	 *
	 * Renders the block list plus the §7 notice states (DB unavailable, no
	 * projects, missing config directory). The shared session content loader is
	 * owned by the page (so the header Reload control can reset it) and reaches
	 * every row through the `load` prop.
	 */
	import type { FileBlock, FileContent } from '$lib/model/files';
	import FileBlockView from './FileBlock.svelte';

	interface Props {
		blocks: readonly FileBlock[];
		projectsAvailable: boolean;
		/** Shared session loader (one fetch per `block|path`). */
		load: (block: string, path: string) => Promise<FileContent>;
	}

	let { blocks, projectsAvailable, load }: Props = $props();

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
		<FileBlockView {block} {load} />
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
