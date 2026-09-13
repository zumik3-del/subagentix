<script lang="ts">
	import { page } from '$app/state';
</script>

<main>
	<h1>{page.status}</h1>
	<p class="error">{page.error?.message ?? 'Unexpected error.'}</p>
	<p class="back"><a href="/">← All sessions</a></p>
</main>

<style>
	main {
		max-width: 44rem;
		margin: var(--space-12) auto;
		padding: 0 var(--space-6);
	}

	h1 {
		margin: 0 0 var(--space-2);
		font-size: var(--font-size-x-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.error {
		background: var(--color-danger-surface);
		border: 1px solid var(--color-danger-border);
		border-radius: var(--radius-lg);
		padding: var(--space-4);
		color: var(--text-base);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.back {
		margin-top: var(--space-4);
	}

	.back a {
		color: var(--text-interactive-base);
	}
</style>
