<script lang="ts">
	/**
	 * Widget picker dialog (dashboard Phase 5, task #414; show/hide only in #449).
	 *
	 * Lists every registry widget in registry order with a visibility toggle and
	 * a `Restore defaults` action. Drafts the selection locally and persists it
	 * through the shared `saveDashboardWidgets` helper on Apply; per-widget sizes
	 * live in the gear-opened `WidgetSettings` dialog. Cancel (and Escape /
	 * backdrop click) discards the draft; the parent owns `open` and applies the
	 * saved selection. Focus handling follows docs/ui-standards.md §9: dialog
	 * semantics, Escape close, a Tab trap and focus return to the opener.
	 */
	import { tick } from 'svelte';
	import ScrollView from '$lib/components/primitives/ScrollView.svelte';
	import { DEFAULT_WIDGETS, WIDGET_DEFS, resolvePlacements } from '$lib/widgets/registry';
	import type { WidgetId, WidgetPlacement } from '$lib/widgets/registry';
	import { samePlacements, toggleWidgetSelection } from './picker';
	import { saveDashboardWidgets } from './save';

	interface Props {
		open: boolean;
		/** Currently applied placements, used as the draft's baseline. */
		selected: readonly WidgetPlacement[];
		/** Called with the server-normalised placements after a successful save. */
		onApply: (placements: WidgetPlacement[]) => void;
		onClose: () => void;
	}

	let { open, selected, onApply, onClose }: Props = $props();

	let draft = $state<WidgetPlacement[]>([]);
	let saving = $state(false);
	let error = $state<string | null>(null);

	let dialog = $state<HTMLDivElement | null>(null);
	let previouslyFocused: HTMLElement | null = null;
	let wasOpen = false;

	/** Checked widgets and their current size, keyed by id. */
	const draftById = $derived(new Map(draft.map((placement) => [placement.id, placement] as const)));

	// Apply is enabled only when the draft differs from the applied placements
	// (a size-only change counts as dirty).
	const dirty = $derived(!samePlacements(draft, selected));

	$effect(() => {
		const isOpen = open;
		if (isOpen && !wasOpen) {
			wasOpen = true;
			draft = resolvePlacements(selected);
			error = null;
			saving = false;
			previouslyFocused =
				typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
			void tick().then(() => dialog?.focus());
		} else if (!isOpen && wasOpen) {
			wasOpen = false;
			previouslyFocused?.focus();
		}
	});

	function toggle(id: WidgetId): void {
		draft = toggleWidgetSelection(draft, id);
	}

	function restoreDefaults(): void {
		draft = resolvePlacements(DEFAULT_WIDGETS);
	}

	function onDialogKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
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

	async function apply(): Promise<void> {
		if (saving) return;
		saving = true;
		error = null;
		try {
			const saved = await saveDashboardWidgets(draft);
			onApply(saved);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
			saving = false;
		}
	}
</script>

{#if open}
	<div class="ui-modal">
		<button
			type="button"
			class="ui-modal__backdrop"
			aria-label="Close widget picker"
			onclick={onClose}
		></button>
		<div
			class="ui-modal__dialog widgets-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="widgets-title"
			tabindex="-1"
			bind:this={dialog}
			onkeydown={onDialogKeydown}
		>
			<header class="ui-modal__head">
				<h2 class="ui-modal__title" id="widgets-title">Widgets</h2>
			</header>

			<div class="ui-modal__body">
				<ScrollView>
					<div class="ui-modal__content">
						{#if error}
							<p class="message error" role="alert">{error}</p>
						{/if}
						<ul class="widget-list">
							{#each WIDGET_DEFS as def (def.id)}
								{@const placement = draftById.get(def.id)}
								<li class="widget-row">
									<label class="widget-item">
										<input
											type="checkbox"
											checked={placement !== undefined}
											onchange={() => toggle(def.id)}
											disabled={saving}
										/>
										<span class="widget-main">
											<span class="widget-title">{def.title}</span>
											<span class="widget-meta">tier {def.tier}</span>
										</span>
									</label>
								</li>
							{/each}
						</ul>
					</div>
				</ScrollView>
			</div>

			<footer class="ui-modal__foot">
				<button type="button" class="ui-btn restore" onclick={restoreDefaults} disabled={saving}>
					Restore defaults
				</button>
				<button type="button" class="ui-btn" onclick={onClose} disabled={saving}>Cancel</button>
				<button
					type="button"
					class="ui-btn ui-btn--primary"
					onclick={() => void apply()}
					disabled={saving || !dirty}
				>
					{saving ? 'Saving…' : 'Apply'}
				</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	/* Size only — shape/behavior come from the global `.ui-modal` contract. */
	.widgets-dialog {
		width: 28rem;
		max-width: calc(100vw - 2rem);
		max-height: min(32rem, calc(100dvh - 2rem));
	}

	.widget-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.widget-row {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		background: var(--surface-base);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
	}

	.widget-item {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		cursor: pointer;
	}

	.widget-item input {
		flex: none;
		accent-color: var(--border-selected);
	}

	.widget-main {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}

	.widget-title {
		color: var(--text-strong);
	}

	.widget-meta {
		font-size: var(--font-size-small);
		color: var(--text-faint);
	}

	.restore {
		margin-inline-end: auto;
	}

	.message {
		margin: 0 0 var(--space-2);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-small);
	}

	.message.error {
		color: var(--color-danger-strong);
		border: 1px solid var(--color-danger-border);
	}
</style>
