<script lang="ts">
	/**
	 * Widget picker dialog (dashboard Phase 5, task #414; resizable in #438).
	 *
	 * Lists every registry widget in registry order with a toggle, and for each
	 * checked widget a width (1–4 quarter-width blocks) and height (1–8 rows)
	 * control. Drafts the selection + sizes locally and persists them through
	 * `PUT /api/settings` on Apply. Cancel (and Escape / backdrop click)
	 * discards the draft; the parent owns `open` and applies the saved
	 * selection. Focus handling follows docs/ui-standards.md §9: dialog
	 * semantics, Escape close, a Tab trap and focus return to the opener.
	 */
	import { tick } from 'svelte';
	import ScrollView from '$lib/components/primitives/ScrollView.svelte';
	import {
		DEFAULT_WIDGETS,
		WIDGET_DEFS,
		WIDGET_MAX_HEIGHT,
		WIDGET_MIN_HEIGHT,
		resolvePlacements
	} from '$lib/widgets/registry';
	import type { WidgetId, WidgetPlacement } from '$lib/widgets/registry';
	import { samePlacements, toggleWidgetSelection, updatePlacement } from './picker';

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

	function setWidth(id: WidgetId, value: string): void {
		draft = updatePlacement(draft, id, { width: Number(value) });
	}

	function stepHeight(id: WidgetId, delta: number): void {
		const current = draftById.get(id)?.height ?? WIDGET_MIN_HEIGHT;
		draft = updatePlacement(draft, id, { height: current + delta });
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
			const response = await fetch('/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: draft })
			});
			if (!response.ok) {
				const data = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(data.error ?? `Could not save widgets (${response.status}).`);
			}
			const data = (await response.json()) as { dashboardWidgets?: unknown };
			const saved = Array.isArray(data.dashboardWidgets)
				? resolvePlacements(data.dashboardWidgets)
				: draft;
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

									{#if placement}
										<div class="widget-size">
											<span class="widget-field">
												<label class="widget-field__label" for={`width-${def.id}`}>Width</label>
												<select
													id={`width-${def.id}`}
													class="widget-select"
													value={String(placement.width)}
													disabled={saving}
													onchange={(event) => setWidth(def.id, event.currentTarget.value)}
												>
													<option value="1">1 block</option>
													<option value="2">2 blocks</option>
													<option value="3">3 blocks</option>
													<option value="4">4 blocks (full)</option>
												</select>
											</span>

											<span class="widget-field">
												<span class="widget-field__label" id={`height-${def.id}`}>Height</span>
												<span
													class="widget-stepper"
													role="group"
													aria-labelledby={`height-${def.id}`}
												>
													<button
														type="button"
														class="widget-step"
														aria-label={`Decrease ${def.title} height`}
														disabled={saving || placement.height <= WIDGET_MIN_HEIGHT}
														onclick={() => stepHeight(def.id, -1)}
													>
														−
													</button>
													<span class="widget-step__value" aria-live="polite">
														{placement.height}
													</span>
													<button
														type="button"
														class="widget-step"
														aria-label={`Increase ${def.title} height`}
														disabled={saving || placement.height >= WIDGET_MAX_HEIGHT}
														onclick={() => stepHeight(def.id, 1)}
													>
														+
													</button>
												</span>
											</span>
										</div>
									{/if}
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

	.widget-size {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		padding-inline-start: calc(var(--space-6) + var(--space-3));
	}

	.widget-field {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.widget-field__label {
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.widget-select {
		padding: var(--space-1) var(--space-2);
		background: var(--surface-base);
		color: var(--text-strong);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
		font: inherit;
		font-size: var(--font-size-small);
	}

	.widget-stepper {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
	}

	.widget-step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--space-5);
		height: var(--space-5);
		padding: 0;
		background: var(--surface-raised-base);
		color: var(--text-base);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
		font: inherit;
		line-height: 1;
		cursor: pointer;
	}

	.widget-step:hover:not(:disabled) {
		background: var(--surface-raised-base-hover);
		color: var(--text-strong);
	}

	.widget-step:disabled {
		cursor: default;
		color: var(--text-weaker);
	}

	.widget-step__value {
		min-width: 1.5ch;
		text-align: center;
		font-size: var(--font-size-small);
		font-variant-numeric: tabular-nums;
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
