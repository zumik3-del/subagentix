<script lang="ts">
	/**
	 * Pure presentation of a normalised ziptask task (`TrackerTaskDetail`).
	 *
	 * Kept separate from {@link TaskModal} so the detail layout (meta, empty
	 * description/comments) can be server-rendered in tests without a fetch.
	 * Every dynamic value is escaped by Svelte; no raw-HTML injection is used.
	 */
	import { formatIsoDateTime } from '$lib/model/format';
	import type { TrackerTaskDetail } from '$lib/model/tracker';

	let { detail }: { detail: TrackerTaskDetail } = $props();

	const task = $derived(detail.task);
	const meta = $derived(
		[
			{ label: 'Status', value: task.status },
			{ label: 'Priority', value: task.priority ?? '—' },
			{ label: 'Assignee', value: task.assignee ?? '—' },
			{ label: 'Reporter', value: task.reporter || '—' },
			{ label: 'Attempts', value: `${task.attempts}/${task.maxAttempts}` },
			{ label: 'Created', value: formatIsoDateTime(task.createdAt) },
			{ label: 'Updated', value: formatIsoDateTime(task.updatedAt) },
			...(task.completedAt ? [{ label: 'Completed', value: formatIsoDateTime(task.completedAt) }] : []),
			...(task.epicId !== null ? [{ label: 'Epic', value: `#${task.epicId}` }] : [])
		].filter((entry) => entry.value !== '')
	);
</script>

<div class="detail">
	<h4 class="title">{task.title}</h4>
	{#if task.isEpic}
		<span class="ui-chip epic">epic</span>
	{/if}

	<dl class="meta">
		{#each meta as entry (entry.label)}
			<div class="meta-item">
				<dt>{entry.label}</dt>
				<dd>{entry.value}</dd>
			</div>
		{/each}
	</dl>

	<section class="block">
		<h5>Description</h5>
		{#if task.description}
			<p class="description">{task.description}</p>
		{:else}
			<p class="empty">No description.</p>
		{/if}
	</section>

	<section class="block">
		<h5>Comments ({detail.comments.length})</h5>
		{#if detail.comments.length === 0}
			<p class="empty">No comments.</p>
		{:else}
			{#each detail.comments as comment (comment.id)}
				<article class="comment">
					<header>
						<span class="agent">{comment.agent || 'unknown'}</span>
						{#if comment.type && comment.type !== 'comment'}
							<span class="ui-badge type">{comment.type}</span>
						{/if}
						<time>{formatIsoDateTime(comment.createdAt)}</time>
					</header>
					<div class="content">{comment.content}</div>
				</article>
			{/each}
		{/if}
	</section>
</div>

<style>
	.detail {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.title {
		margin: 0;
		font-size: var(--font-size-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.epic {
		align-self: flex-start;
	}

	.meta {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: var(--space-2) var(--space-4);
		margin: 0;
	}

	.meta-item {
		min-width: 0;
	}

	.meta dt {
		font-size: var(--font-size-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-weak);
	}

	.meta dd {
		margin: var(--space-1) 0 0;
		font-size: var(--font-size-small);
		color: var(--text-strong);
		overflow-wrap: anywhere;
	}

	.block h5 {
		margin: 0 0 var(--space-1);
		font-size: var(--font-size-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-weak);
	}

	.description {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: var(--font-size-small);
		color: var(--text-base);
	}

	.empty {
		margin: 0;
		color: var(--text-weak);
		font-size: var(--font-size-small);
	}

	.comment {
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
		background: var(--surface-base);
		padding: var(--space-2) var(--space-3);
		margin-bottom: var(--space-2);
	}

	.comment header {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2);
		margin-bottom: var(--space-1);
		font-size: var(--font-size-xs);
	}

	.agent {
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.comment time {
		color: var(--text-weak);
		font-variant-numeric: tabular-nums;
	}

	.comment .content {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: var(--font-size-small);
		color: var(--text-base);
	}
</style>
