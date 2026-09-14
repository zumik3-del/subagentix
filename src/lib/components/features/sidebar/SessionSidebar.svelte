<script lang="ts">
	/**
	 * Session navigator for the app shell (task #212).
	 *
	 * A three-level, file-tree-v2-styled tree: directory
	 * (`GET /api/sessions?directory=&limit=&offset=`) → session
	 * (`GET /api/sessions/[id]` turns) → turn leaf. Directory and session
	 * children load lazily on first expand and are cached per node. A non-empty
	 * search `q` collapses the tree to a flat list of matching root sessions.
	 *
	 * Client-only: no `$lib/server` imports; the first directory and its first
	 * session page arrive from the layout loader (`+layout.server.ts`).
	 */
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { formatDateTime } from '$lib/model/format';
	import { displayAgent } from '$lib/model/agent';
	import type { DirectorySummary, TurnSummary } from '$lib/model/types';
	import TreeIcon from '$lib/components/primitives/TreeIcon.svelte';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import ScrollView from '$lib/components/primitives/ScrollView.svelte';

	interface SidebarSession {
		id: string;
		title: string;
		agent: string;
		directory: string;
		createdAt: number;
		updatedAt: number;
		childCount: number;
	}

	interface SidebarInitial {
		directories: DirectorySummary[];
		/** Directory whose first session page is pre-seeded and pre-expanded. */
		directory: string | null;
		sessions: SidebarSession[];
		limit: number;
	}

	interface Props {
		initial: SidebarInitial | null;
		/** Called when a turn link is followed (the shell closes the overlay). */
		onNavigate?: () => void;
		/** Opens the runtime settings dialog owned by the layout (task #257). */
		onOpenSettings?: () => void;
		/** Whether that dialog is currently open (drives `aria-expanded`). */
		settingsOpen?: boolean;
	}

	let { initial, onNavigate, onOpenSettings, settingsOpen = false }: Props = $props();

	// `initial` is a one-shot SSR seed, never re-assigned while mounted, so it
	// is read untracked below (silences `state_referenced_locally`).
	const PAGE_SIZE = untrack(() => initial?.limit ?? 30);
	const SEARCH_DEBOUNCE_MS = 250;

	let directories = $state<DirectorySummary[]>(untrack(() => initial?.directories ?? []));
	let dirSessions = $state<Record<string, SidebarSession[]>>(
		untrack(() => {
			const first = initial?.directory;
			return first != null ? { [first]: initial?.sessions ?? [] } : {};
		})
	);
	let expandedDirs = $state<Record<string, boolean>>(
		untrack(() => {
			const first = initial?.directory;
			return first != null ? { [first]: true } : {};
		})
	);
	let dirLoading = $state<Record<string, boolean>>({});
	let dirError = $state<Record<string, string>>({});

	let expandedSessions = $state<Record<string, boolean>>({});
	let turns = $state<Record<string, TurnSummary[]>>({});
	let turnsLoading = $state<Record<string, boolean>>({});
	let turnsError = $state<Record<string, string>>({});

	let query = $state('');
	let searchOpen = $state(false);
	let searchResults = $state<SidebarSession[]>([]);
	let searchLoading = $state(false);
	let searchError = $state<string | null>(null);
	let searchHasMore = $state(false);

	// `initial === null` means the data layer failed to seed the sidebar; the
	// tree still must not take the page down, so the client shows this error.
	let loadError = $state<string | null>(
		untrack(() => (initial ? null : 'Session list unavailable.'))
	);

	/** Active root session id parsed from the current URL, or `null`. */
	const activeSessionId = $derived.by(() => {
		const match = /^\/sessions\/([^/]+)/.exec(page.url.pathname);
		return match ? decodeURIComponent(match[1]) : null;
	});
	const activeTurnId = $derived(page.url.searchParams.get('turn'));

	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	// Last-write-wins guards: `searchSeq` serializes the flat search list;
	// `requestSeq` serializes each lazily loaded directory/session node so
	// concurrent node loads never cancel each other.
	let searchSeq = 0;
	const requestSeq = new Map<string, number>();
	function nextRequestSeq(key: string): number {
		const next = (requestSeq.get(key) ?? 0) + 1;
		requestSeq.set(key, next);
		return next;
	}

	function onSearchInput(value: string): void {
		query = value;
		clearTimeout(searchTimer);
		if (value.trim() === '') {
			searchOpen = false;
			searchError = null;
			return;
		}
		searchOpen = true;
		searchTimer = setTimeout(() => void runSearch(), SEARCH_DEBOUNCE_MS);
	}

	async function fetchSessions(
		offset: number,
		q: string,
		directory?: string
	): Promise<SidebarSession[]> {
		const params = new URLSearchParams();
		params.set('limit', String(PAGE_SIZE));
		params.set('offset', String(offset));
		if (q.trim() !== '') params.set('q', q.trim());
		if (directory !== undefined) params.set('directory', directory);
		const response = await fetch(`/api/sessions?${params.toString()}`);
		if (!response.ok) throw new Error(`Could not load sessions (${response.status}).`);
		return (await response.json()) as SidebarSession[];
	}

	/** Run the debounced search; replace the tree with the matching sessions. */
	async function runSearch(): Promise<void> {
		const term = query.trim();
		if (term === '') return;
		const seq = ++searchSeq;
		searchLoading = true;
		searchError = null;
		// Drop the previous term's rows so a slow response never shows as the
		// wrong query's result.
		searchResults = [];
		searchHasMore = false;
		try {
			const results = await fetchSessions(0, term);
			if (seq !== searchSeq) return;
			searchResults = results;
			searchHasMore = results.length === PAGE_SIZE;
		} catch (cause) {
			if (seq !== searchSeq) return;
			searchError = cause instanceof Error ? cause.message : String(cause);
			searchResults = [];
			searchHasMore = false;
		} finally {
			if (seq === searchSeq) searchLoading = false;
		}
	}

	async function loadMoreSearch(): Promise<void> {
		if (searchLoading) return;
		const seq = ++searchSeq;
		searchLoading = true;
		searchError = null;
		try {
			const next = await fetchSessions(searchResults.length, query);
			if (seq !== searchSeq) return;
			searchResults = [...searchResults, ...next];
			searchHasMore = next.length === PAGE_SIZE;
		} catch (cause) {
			if (seq !== searchSeq) return;
			searchError = cause instanceof Error ? cause.message : String(cause);
			searchResults = [];
			searchHasMore = false;
		} finally {
			if (seq === searchSeq) searchLoading = false;
		}
	}

	/** Toggle a directory; the first expand lazily loads (and caches) a page. */
	async function toggleDirectory(directory: string): Promise<void> {
		if (expandedDirs[directory]) {
			expandedDirs = { ...expandedDirs, [directory]: false };
			return;
		}
		expandedDirs = { ...expandedDirs, [directory]: true };
		if (dirSessions[directory] || dirLoading[directory]) return;
		await loadDirectory(directory, 0);
	}

	/** Load one page of a directory's sessions (offset pages the newest-first list). */
	async function loadDirectory(directory: string, offset: number): Promise<void> {
		const key = `dir:${directory}`;
		const seq = nextRequestSeq(key);
		dirLoading = { ...dirLoading, [directory]: true };
		dirError = { ...dirError, [directory]: '' };
		try {
			const page = await fetchSessions(offset, '', directory);
			if (requestSeq.get(key) !== seq) return;
			const existing = offset === 0 ? [] : (dirSessions[directory] ?? []);
			dirSessions = { ...dirSessions, [directory]: [...existing, ...page] };
		} catch (cause) {
			if (requestSeq.get(key) !== seq) return;
			dirError = {
				...dirError,
				[directory]: cause instanceof Error ? cause.message : String(cause)
			};
		} finally {
			if (requestSeq.get(key) === seq) dirLoading = { ...dirLoading, [directory]: false };
		}
	}

	/** Toggle a session; the first expand lazily loads and caches its turns. */
	async function toggleSession(id: string): Promise<void> {
		if (expandedSessions[id]) {
			expandedSessions = { ...expandedSessions, [id]: false };
			return;
		}
		expandedSessions = { ...expandedSessions, [id]: true };
		if (turns[id] || turnsLoading[id]) return;
		await loadTurns(id);
	}

	async function loadTurns(id: string): Promise<void> {
		const key = `turns:${id}`;
		const seq = nextRequestSeq(key);
		turnsLoading = { ...turnsLoading, [id]: true };
		turnsError = { ...turnsError, [id]: '' };
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
			if (!response.ok) throw new Error(`Could not load turns (${response.status}).`);
			const detail = (await response.json()) as { turns: TurnSummary[] };
			if (requestSeq.get(key) !== seq) return;
			turns = { ...turns, [id]: detail.turns };
		} catch (cause) {
			if (requestSeq.get(key) !== seq) return;
			turnsError = {
				...turnsError,
				[id]: cause instanceof Error ? cause.message : String(cause)
			};
		} finally {
			if (requestSeq.get(key) === seq) turnsLoading = { ...turnsLoading, [id]: false };
		}
	}
</script>

{#snippet sessionNode(session: SidebarSession)}
	{@const isOpen = expandedSessions[session.id] ?? false}
	{@const isActive = session.id === activeSessionId}
	{@const isActiveLeafParent = isActive && activeTurnId !== null}
	<li>
		<button
			type="button"
			class="row row-session ui-focus-inset"
			class:selected={isActive && !isActiveLeafParent}
			class:contains-active={isActiveLeafParent}
			aria-expanded={isOpen}
			aria-controls={`turns-${session.id}`}
			onclick={() => void toggleSession(session.id)}
		>
			<span class="chevron"><TreeIcon name="chevron" expanded={isOpen} /></span>
			<span class="session-title" title={`${displayAgent(session.agent)} · ${session.title || session.id}`}>
				{session.title || session.id}
			</span>
		</button>
		{#if isOpen}
			<ul class="children" id={`turns-${session.id}`}>
				{@render turnsContent(session.id)}
			</ul>
		{/if}
	</li>
{/snippet}

{#snippet turnsContent(sessionId: string)}
	{#if turnsLoading[sessionId]}
		<li><p class="note">Loading turns…</p></li>
	{:else if turnsError[sessionId]}
		<li><p class="note error" role="alert">{turnsError[sessionId]}</p></li>
	{:else if (turns[sessionId] ?? []).length === 0}
		<li><p class="note">No turns.</p></li>
	{:else}
		{#each turns[sessionId] ?? [] as turn (turn.turnId)}
			{@const isTurnActive = sessionId === activeSessionId && turn.turnId === activeTurnId}
			<li>
				<a
					class="row row-turn ui-focus-inset"
					class:selected={isTurnActive}
					href={`/sessions/${encodeURIComponent(sessionId)}?turn=${encodeURIComponent(turn.turnId)}`}
					onclick={() => onNavigate?.()}
				>
					<span class="chevron-spacer" aria-hidden="true"></span>
					<span class="row-label">Turn {turn.index}</span>
					<span class="row-meta">{formatDateTime(turn.startedAt)}</span>
				</a>
			</li>
		{/each}
	{/if}
{/snippet}

<aside class="sidebar" id="session-sidebar" aria-label="Session navigator">
	<div class="sidebar-header">
		<div class="brand-row">
			<a class="brand" href="/">subagentix</a>
			<button
				type="button"
				class="ui-icon-btn settings-button"
				aria-label="Settings"
				aria-haspopup="dialog"
				aria-expanded={settingsOpen}
				aria-controls="settings-dialog"
				onclick={() => onOpenSettings?.()}
			>
				<Icon name="gear" />
			</button>
		</div>
		<label class="search">
			<span class="sr-only">Search sessions</span>
			<input
				class="ui-input"
				type="search"
				placeholder="Search sessions…"
				value={query}
				oninput={(event) => onSearchInput(event.currentTarget.value)}
			/>
		</label>
	</div>

	<ScrollView>
		<div class="sidebar-body">
			{#if loadError}
				<p class="note error" role="alert">{loadError}</p>
			{:else if searchOpen}
				{#if searchError}
					<p class="note error" role="alert">{searchError}</p>
				{:else if searchLoading && searchResults.length === 0}
					<p class="note">Loading sessions…</p>
				{:else if searchResults.length === 0}
					<p class="note">No matching sessions.</p>
				{:else}
					<ul class="tree">
						{#each searchResults as session (session.id)}
							{@render sessionNode(session)}
						{/each}
					</ul>
					{#if searchHasMore}
						<div class="more">
							<button
								type="button"
								class="ui-btn ui-btn--block load-more"
								onclick={() => void loadMoreSearch()}
								disabled={searchLoading}
							>
								{searchLoading ? 'Loading…' : 'Load more'}
							</button>
						</div>
					{/if}
				{/if}
			{:else if directories.length === 0}
				<p class="note">No sessions available.</p>
			{:else}
				<ul class="tree">
					{#each directories as directory, index (directory.directory)}
						{@const isOpen = expandedDirs[directory.directory] ?? false}
						{@const sessions = dirSessions[directory.directory] ?? []}
						{@const isLoading = dirLoading[directory.directory] ?? false}
						{@const directoryError = dirError[directory.directory] ?? ''}
						<li>
							<button
								type="button"
								class="row row-directory ui-focus-inset"
								aria-expanded={isOpen}
								aria-controls={`directory-${index}`}
								title={directory.directory}
								onclick={() => void toggleDirectory(directory.directory)}
							>
								<span class="chevron"><TreeIcon name="chevron" expanded={isOpen} /></span>
								<span class="folder"><TreeIcon name="folder" /></span>
								<span class="row-label directory-label">{directory.projectName ?? directory.directory}</span>
								<span class="row-count">{directory.sessionCount}</span>
							</button>

							{#if isOpen}
								<ul class="children" id={`directory-${index}`}>
									{#if isLoading && sessions.length === 0}
										<li><p class="note">Loading sessions…</p></li>
									{:else if directoryError}
										<li><p class="note error" role="alert">{directoryError}</p></li>
									{:else if sessions.length === 0}
										<li><p class="note">No sessions.</p></li>
									{/if}

									{#each sessions as session (session.id)}
										{@render sessionNode(session)}
									{/each}

									{#if sessions.length > 0 && sessions.length < directory.sessionCount}
										<li>
											<button
												type="button"
												class="row row-more ui-focus-inset"
												onclick={() => void loadDirectory(directory.directory, sessions.length)}
												disabled={isLoading}
											>
												{isLoading ? 'Loading…' : 'Load more'}
											</button>
										</li>
									{/if}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</ScrollView>
</aside>

<style>
	.sidebar {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--background-strong);
	}

	/*
	 * The header is a fixed (non-scrolling) row: it sits above the `ScrollView`
	 * below, so tree content can never slide under it. Only the region after
	 * this header scrolls (task #228).
	 */
	.sidebar-header {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-4) var(--space-3);
		background: var(--background-strong);
		border-bottom: 1px solid var(--border-weak-base);
	}

	.brand-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.brand {
		font-size: var(--font-size-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
		text-decoration: none;
	}

	.tree,
	.children {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.tree {
		padding: var(--space-1) var(--space-2) var(--space-2);
	}

	/* Indentation + the 1px guide line per nesting level (file-tree-v2). */
	.children {
		position: relative;
		padding-inline-start: var(--space-4);
	}

	.children::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		inset-inline-start: var(--space-4);
		width: 1px;
		background: var(--border-muted);
		opacity: 0;
		pointer-events: none;
		transition: opacity 120ms ease;
	}

	.tree:hover .children::before {
		opacity: 0.5;
	}

	.row {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		height: 28px;
		display: flex;
		align-items: center;
		gap: var(--space-1);
		padding-inline: var(--space-2);
		background-color: transparent;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--text-base);
		font: inherit;
		text-align: start;
		text-decoration: none;
		cursor: pointer;
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}

	.row:hover {
		background-color: var(--overlay-hover);
	}

	.row.selected,
	.row.selected:hover {
		background-color: var(--overlay-pressed);
		color: var(--text-strong);
	}

	/*
	 * Session that contains the active turn leaf (task #228): a background-free
	 * cue only, so the session and the turn it contains can never paint stacked
	 * `--overlay-pressed` selections. The cue is the strong, medium-weight title.
	 */
	.row.contains-active .session-title {
		color: var(--text-strong);
		font-weight: var(--font-weight-medium);
	}

	.row:disabled {
		cursor: default;
		color: var(--text-faint);
	}

	.chevron,
	.chevron-spacer,
	.folder {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		flex: none;
	}

	.chevron,
	.folder {
		color: var(--icon-base);
	}

	.row.selected .chevron {
		color: var(--text-strong);
	}

	.row-label {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: start;
	}

	.directory-label {
		color: var(--text-strong);
		font-weight: var(--font-weight-medium);
	}

	.session-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-faint);
	}

	.row-count,
	.row-meta {
		flex: none;
		color: var(--text-faint);
		font-size: var(--font-size-small);
		font-variant-numeric: tabular-nums;
	}

	.row-more {
		justify-content: center;
		color: var(--text-weak);
	}

	.note {
		margin: var(--space-1) var(--space-3);
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.note.error {
		color: var(--color-danger-strong);
	}

	.more {
		padding: var(--space-1) var(--space-3) var(--space-2);
	}
</style>
