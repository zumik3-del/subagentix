<script lang="ts">
	/**
	 * Small modal that shows one inferred ziptask task (meta + description +
	 * comments). It fetches subagentix's own `/api/tracker/task/:id` proxy, so
	 * the ziptask base URL never reaches the browser.
	 *
	 * Mounted only on the client (a chip click sets the id), so the load runs
	 * from an `$effect`; SSR renders the loading state.
	 */
	import { normaliseTaskDetail, type TrackerTaskDetail } from '$lib/model/tracker';
	import ScrollView from './ScrollView.svelte';
	import TaskDetailView from './TaskDetailView.svelte';

	let { id, onClose }: { id: string; onClose?: () => void } = $props();

	let detail = $state<TrackerTaskDetail | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let dialog: HTMLDivElement | undefined = $state();
	let previouslyFocused: HTMLElement | null = null;

	async function readJson(response: Response): Promise<unknown> {
		try {
			return await response.json();
		} catch {
			return null;
		}
	}

	function errorMessage(body: unknown, status: number): string {
		if (body !== null && typeof body === 'object') {
			const message = (body as { error?: unknown }).error;
			if (typeof message === 'string' && message !== '') return message;
		}
		return `Could not load task (${status}).`;
	}

	async function load(signal: AbortSignal): Promise<void> {
		loading = true;
		error = null;
		detail = null;
		try {
			const response = await fetch(`/api/tracker/task/${encodeURIComponent(id)}`, { signal });
			const body = await readJson(response);
			if (!response.ok) {
				error = errorMessage(body, response.status);
				return;
			}
			const parsed = normaliseTaskDetail(body);
			if (parsed === null) {
				error = 'Unexpected response from the server.';
				return;
			}
			detail = parsed;
		} catch (cause) {
			if (signal.aborted) return;
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (!signal.aborted) loading = false;
		}
	}

	$effect(() => {
		const controller = new AbortController();
		previouslyFocused =
			typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
		void load(controller.signal);
		return () => controller.abort();
	});

	$effect(() => {
		dialog?.focus();
		return () => previouslyFocused?.focus();
	});

	function onDialogKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose?.();
			return;
		}
		if (event.key !== 'Tab' || !dialog) return;
		const focusables = Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
			)
		);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement;
		if (event.shiftKey && (active === first || !dialog.contains(active))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && active === last) {
			event.preventDefault();
			first.focus();
		}
	}
</script>

<div class="ui-modal task-modal">
	<button
		type="button"
		class="ui-modal__backdrop"
		aria-label={`Close task #${id}`}
		onclick={onClose}
	></button>
	<div
		class="ui-modal__dialog task-dialog"
		role="dialog"
		aria-modal="true"
		aria-label={`Task #${id} details`}
		tabindex="-1"
		bind:this={dialog}
		onkeydown={onDialogKeydown}
	>
		<header class="ui-modal__head">
			<h3 class="ui-modal__title">Task #{id}</h3>
			<button type="button" class="ui-btn" aria-label={`Close task #${id}`} onclick={onClose}>
				Close
			</button>
		</header>
		<div class="ui-modal__body">
			<ScrollView>
				<div class="ui-modal__content">
					{#if loading}
						<p class="state" role="status">Loading…</p>
					{:else if error}
						<p class="state error" role="alert">{error}</p>
					{:else if detail}
						<TaskDetailView {detail} />
					{/if}
				</div>
			</ScrollView>
		</div>
	</div>
</div>

<style>
	/* Size only — shape/behavior come from the global `.ui-modal` contract. */
	.task-modal {
		z-index: 110;
	}

	.task-dialog {
		width: min(34rem, calc(100vw - 2rem));
	}

	.state {
		margin: 0;
		color: var(--text-weak);
		font-size: var(--font-size-small);
	}

	.state.error {
		color: var(--color-danger-strong);
	}
</style>
