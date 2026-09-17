<script lang="ts">
	/**
	 * Dashboard shell root (dashboard Phase 3, task #404).
	 *
	 * Owns the selected-widget set (seeded from settings via the page loader)
	 * and composes the header + responsive grid. The header's `actions` slot
	 * hosts the global period/project selector (#415) and the "Widgets" picker
	 * button (#414). The filter is a prop with a default so the shell renders
	 * standalone; the landing page supplies it from URL state (falling back to
	 * the stored preference) and receives every selector change through
	 * `onFilterChange` — the shell itself never persists the filter (#457). Each
	 * selected widget mounts lazily and fetches its own data through the grid's
	 * registry loaders, re-fetching whenever the filter prop changes (tasks
	 * #410/#415).
	 *
	 * Since #449 the shell also owns the per-widget size-settings target: a gear
	 * on a card opens one `WidgetSettings` dialog whose changes apply
	 * optimistically and persist through the shared coalescing writer.
	 *
	 * Since #492 the shell provides the detail-overlay controls through context
	 * and mounts the single `DetailHost`; widget bodies open a detail without a
	 * threaded callback and the page keeps owning the URL state.
	 */
	import type { DashboardFilter } from '$lib/model/dashboard';
	import type { ToolCallDetail } from '$lib/model/tool-errors';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import {
		findWidgetDef,
		resolvePlacements,
		type WidgetId,
		type WidgetPlacement
	} from '$lib/widgets/registry';
	import DashboardHeader from './DashboardHeader.svelte';
	import DetailHost from './DetailHost.svelte';
	import FilterSelector from './FilterSelector.svelte';
	import WidgetGrid from './WidgetGrid.svelte';
	import WidgetSettings from './WidgetSettings.svelte';
	import WidgetsModal from './WidgetsModal.svelte';
	import { detailTargetFor, setDetailControls, type DetailTarget } from './detail';
	import { DEFAULT_FILTER, type FilterOption } from './filter';
	import { updatePlacement } from './picker';
	import { createCoalescingWriter, saveDashboardWidgets } from './save';
	import type { WidgetSizePatch } from './widget';

	interface Props {
		/** Selected widget placements, already normalised by the settings store. */
		widgets: readonly WidgetPlacement[];
		/** Active global filter; the page derives it from `?period=&scope=`. */
		filter?: DashboardFilter;
		/** Global refresh counter; a change refetches every active widget. */
		refreshToken?: number;
		/** Directory options for the scope selector (no `All projects` entry). */
		scopes?: readonly FilterOption[];
		/** Selector callback; the page turns it into a `goto` URL update. */
		onFilterChange?: (filter: DashboardFilter) => void;
		/**
		 * Tool-call detail overlay target (`?toolErrors=` or `?toolCalls=`);
		 * `null` while closed. The page owns the URL state and passes it down
		 * (tasks #481/#484).
		 */
		toolDetail?: ToolCallDetail | null;
		/** Opens (`detail`) or closes (`null`) the tool-call detail overlay. */
		onToolDetailChange?: (detail: ToolCallDetail | null) => void;
	}

	let {
		widgets,
		filter = DEFAULT_FILTER,
		refreshToken = 0,
		scopes = [],
		onFilterChange,
		toolDetail = null,
		onToolDetailChange
	}: Props = $props();

	/**
	 * Detail-overlay controls for every descendant widget body (task #492).
	 * A body calls `openDetail(target)` / `closeDetail()` from context, so the
	 * callback no longer threads through the grid, host and shell. The URL state
	 * itself stays with the page (the shell only forwards it), keeping the
	 * `?toolErrors=`/`?toolCalls=` deep-link contract unchanged.
	 */
	setDetailControls({
		openDetail: (target: DetailTarget) =>
			onToolDetailChange?.({ tool: target.tool, mode: target.mode }),
		closeDetail: () => onToolDetailChange?.(null)
	});

	/** Registry target for the single `DetailHost` (or `null` while closed). */
	let detailTarget = $derived(
		toolDetail === null ? null : detailTargetFor(toolDetail.tool, toolDetail.mode)
	);

	// Applied selection: starts from the loader, and a save replaces it with
	// the normalised placements the settings API returned, so the grid
	// re-renders without a full reload (tasks #414/#449). A later loader refresh
	// still wins until the next save.
	let applied = $state<WidgetPlacement[] | null>(null);
	/** Last server-confirmed placements; `null` means the loader baseline. */
	let lastSaved = $state<WidgetPlacement[] | null>(null);
	let pickerOpen = $state(false);
	/** Widget whose size settings are open, or `null` while closed. */
	let settingsId = $state<WidgetId | null>(null);
	let settingsError = $state<string | null>(null);
	let settingsSaving = $state(false);

	// Registry order + dedupe + clamp, so the grid always matches the picker.
	let placements = $derived(resolvePlacements(applied ?? widgets));
	let settingsWidget = $derived(settingsId === null ? undefined : findWidgetDef(settingsId));
	let settingsPlacement = $derived(
		settingsId === null ? undefined : placements.find((placement) => placement.id === settingsId)
	);

	// One shared writer for the gear path: rapid size changes collapse into the
	// last one, and a failure restores the last server-confirmed placements.
	const writer = createCoalescingWriter<readonly WidgetPlacement[]>(async (next) => {
		try {
			const saved = await saveDashboardWidgets(next);
			lastSaved = saved;
			applied = saved;
			settingsError = null;
		} catch (cause) {
			applied = lastSaved;
			settingsError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			settingsSaving = false;
		}
	});

	// Drag/resize path (epic #462, stage 3): one PUT per settled gesture, coalesced
	// across rapid ones. The response is only kept for the next save — it is never
	// fed back as `applied`, so it cannot re-render the grid; a rejected PUT leaves
	// `applied` and the live gridstack layout untouched. `applied` is advanced from
	// the reported layout (not the response) so the picker and the next save see it.
	const layoutWriter = createCoalescingWriter<readonly WidgetPlacement[]>(async (next) => {
		try {
			lastSaved = await saveDashboardWidgets(next);
		} catch {
			// Silent by design: the on-screen layout must survive a failed write.
		}
	});

	function onLayoutChange(next: readonly WidgetPlacement[]): void {
		applied = [...next];
		layoutWriter.push(next);
	}

	function onApply(next: readonly WidgetPlacement[]): void {
		applied = [...next];
		lastSaved = [...next];
		pickerOpen = false;
	}

	function onWidgetSettings(id: WidgetId): void {
		settingsId = id;
		settingsError = null;
	}

	function onSettingsChange(patch: WidgetSizePatch): void {
		const id = settingsId;
		if (id === null) return;
		const next = updatePlacement(placements, id, patch);
		applied = next;
		settingsError = null;
		settingsSaving = true;
		writer.push(next);
	}

	function closeSettings(): void {
		settingsId = null;
		settingsError = null;
	}
</script>

<main class="dashboard">
	<DashboardHeader>
		{#snippet actions()}
			<FilterSelector {filter} {scopes} onChange={onFilterChange} />
			<button
				type="button"
				class="ui-icon-btn"
				onclick={() => (pickerOpen = true)}
				aria-label="Widgets"
				title="Widgets"
				aria-haspopup="dialog"
			>
				<Icon name="gear" />
			</button>
		{/snippet}
	</DashboardHeader>

	{#if placements.length === 0}
		<p class="dashboard__empty">
			No widgets selected. Use the gear button to add widgets to your dashboard.
		</p>
	{:else}
		<WidgetGrid
			{placements}
			{filter}
			{refreshToken}
			onWidgetSettings={onWidgetSettings}
			{onLayoutChange}
		/>
	{/if}
</main>

<WidgetsModal
	open={pickerOpen}
	selected={placements}
	onApply={onApply}
	onClose={() => (pickerOpen = false)}
/>

<WidgetSettings
	open={settingsId !== null}
	widget={settingsWidget}
	placement={settingsPlacement}
	saving={settingsSaving}
	error={settingsError}
	onChange={onSettingsChange}
	onClose={closeSettings}
/>

<DetailHost target={detailTarget} {filter} {scopes} />

<style>
	/* Side padding matches the turn page (`/sessions/[id]`): `--space-4`. */
	.dashboard {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
		padding: var(--space-6) var(--space-4) var(--space-12);
	}

	.dashboard__empty {
		margin: 0;
		padding: var(--space-12) var(--space-8);
		border: 1px dashed var(--border-weak-base);
		border-radius: var(--radius-lg);
		text-align: center;
		color: var(--text-weak);
	}
</style>
