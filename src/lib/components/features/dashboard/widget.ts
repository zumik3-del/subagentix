/**
 * Lazy-mount contract for dashboard widgets (dashboard Phase 3, task #409).
 *
 * A widget body is code-split: `WidgetHost` calls a loader only once its host
 * scrolled into view. The loader is the Vite dynamic-import boundary, so no
 * widget module is pulled into the SSR graph or the initial client bundle
 * until then. Kept free of `$lib/server` / DOM so both SSR and client import
 * it.
 */
import type { Component } from 'svelte';
import type { DashboardFilter } from '$lib/model/dashboard';
import type { ToolCallStatus } from '$lib/model/tool-errors';
import type { WidgetDef, WidgetId, WidgetPlacement } from '$lib/widgets/registry';

/**
 * Props every widget body receives from its `WidgetHost` (task #410). The host
 * forwards these from the grid, so a body never reaches for global shell state:
 * it fetches its own `widget.source` with the shared `filter`, and refetches
 * with `?refresh=1` when `refreshToken` changes (global refresh) or its own
 * card refresh control fires (this widget only).
 */
export interface WidgetBodyProps {
	/** Registry entry for this body; supplies the endpoint and card title. */
	widget: WidgetDef;
	/** Active global filter (period + scope), shared by every widget. */
	filter: DashboardFilter;
	/** Global refresh counter; a change refetches this widget with `refresh=1`. */
	refreshToken: number;
	/**
	 * Opens this widget's size-settings modal (task #449). The grid supplies it
	 * for every body; omitted only when the shell has no settings hook.
	 */
	onSettings?: () => void;
	/**
	 * Opens the in-place tool-call detail for a tool (task #481; modes #484).
	 * The shell derives the overlay from the `?toolErrors=`/`?toolCalls=` URL
	 * params and supplies this for every body; omitted only when the shell has no
	 * overlay hook. `mode` selects failures only (`errors`) or every call (`all`).
	 */
	onOpenToolDetail?: (tool: string, mode: ToolCallStatus) => void;
}

/** A width/height patch applied to one placement (task #449). */
export type WidgetSizePatch = Partial<Pick<WidgetPlacement, 'width' | 'height'>>;

/** A widget body component; every body shares the {@link WidgetBodyProps} surface. */
export type WidgetComponent = Component<WidgetBodyProps>;

/** Dynamic import of one widget body; Vite code-splits the target module. */
export type WidgetLoader = () => Promise<{ default: WidgetComponent }>;

/** Per-widget loaders, keyed by registry id; a missing entry stays a skeleton. */
export type WidgetLoaders = Partial<Record<WidgetId, WidgetLoader>>;

/**
 * Per-widget lifecycle state the card chrome renders. Produced by the data
 * hook (task #410) and accepted by `WidgetCard` (only `ready` shows the body).
 */
export type WidgetStatus = 'loading' | 'ready' | 'error' | 'empty';
