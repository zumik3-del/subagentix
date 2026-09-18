<script lang="ts">
	/**
	 * Runtime settings dialog (task #257, ADR §9.2).
	 *
	 * Two tabs — opencode (DB path + subagents folder, both opencode settings)
	 * and ziptask base URL — each with a text field, a Discover action and,
	 * where useful, a candidate list and a refreshable list of parsed
	 * subagents. Talks only to the JSON API; it never imports `$lib/server`.
	 * The parent owns `open` and closes it.
	 */
	import { onDestroy, tick } from 'svelte';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import ScrollView from '$lib/components/primitives/ScrollView.svelte';

	type Tab = 'opencode' | 'ziptask';
	type DiscoverKind = Tab | 'agents';
	const TAB_ORDER: Tab[] = ['opencode', 'ziptask'];

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	interface SettingsResponse {
		dbPath: string;
		ziptaskBaseUrl: string | null;
		ziptaskEnabled: boolean;
		agentsPath: string | null;
		stored: {
			dbPath: string | null;
			ziptaskBaseUrl: string | null;
			ziptaskEnabled: boolean | null;
			agentsPath: string | null;
		};
		source: { dbPath: string; ziptaskBaseUrl: string; ziptaskEnabled: string; agentsPath: string };
		warning?: string;
	}

	interface OpencodeCandidate {
		path: string;
		sessions: number;
		mtimeMs: number;
	}

	interface ZiptaskCandidate {
		baseUrl: string;
		source: 'settings-json' | 'probe';
	}

	interface AgentDirCandidate {
		path: string;
		agentCount: number;
	}

	interface AgentInfo {
		name: string;
		file: string;
		description: string | null;
		model: string | null;
		mode: string | null;
		color: string | null;
		colorVar: string | null;
		temperature: string | null;
	}

	interface CandidateOption {
		value: string;
		detail: string;
	}

	const EMPTY_NOTE: Record<DiscoverKind, string> = {
		opencode: 'No opencode databases found.',
		ziptask: 'No ziptask servers found.',
		agents: 'No subagent folders found.'
	};

	let activeTab = $state<Tab>('opencode');
	let dbPath = $state('');
	let ziptaskBaseUrl = $state('');
	let ziptaskEnabled = $state(true);
	let agentsPath = $state('');
	let baseline = $state({ dbPath: '', ziptaskBaseUrl: '', ziptaskEnabled: true, agentsPath: '' });
	let loading = $state(false);
	let saving = $state(false);
	let discovering = $state(false);
	let error = $state<string | null>(null);
	let warning = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let candidates = $state<CandidateOption[]>([]);
	let discoveredFor = $state<DiscoverKind | null>(null);

	let agents = $state<AgentInfo[]>([]);
	let agentsLoading = $state(false);
	let agentsLoaded = $state(false);
	let agentsLoadedFor = $state<string | null>(null);
	let agentsError = $state<string | null>(null);

	let dialog = $state<HTMLDivElement | null>(null);
	let previouslyFocused: HTMLElement | null = null;
	let wasOpen = false;

	const dirty = $derived(
		dbPath !== baseline.dbPath ||
			ziptaskBaseUrl !== baseline.ziptaskBaseUrl ||
			ziptaskEnabled !== baseline.ziptaskEnabled ||
			agentsPath !== baseline.agentsPath
	);
	const agentsCurrent = $derived(agentsLoaded && agentsLoadedFor === agentsPath.trim());
	const busy = $derived(loading || saving || discovering);

	// Transient footer notice: shown immediately and auto-hidden after a moment.
	const NOTICE_HIDE_MS = 4000;
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;

	function clearNotice(): void {
		if (noticeTimer !== undefined) {
			clearTimeout(noticeTimer);
			noticeTimer = undefined;
		}
		notice = null;
	}

	function showNotice(text: string): void {
		if (noticeTimer !== undefined) clearTimeout(noticeTimer);
		notice = text;
		noticeTimer = setTimeout(() => {
			clearNotice();
			noticeTimer = undefined;
		}, NOTICE_HIDE_MS);
	}

	onDestroy(() => {
		if (noticeTimer !== undefined) clearTimeout(noticeTimer);
	});

	async function load(): Promise<void> {
		loading = true;
		error = null;
		warning = null;
		clearNotice();
		candidates = [];
		discoveredFor = null;
		agents = [];
		agentsLoaded = false;
		agentsLoadedFor = null;
		agentsError = null;
		try {
			const response = await fetch('/api/settings');
			if (!response.ok) throw new Error(`Could not load settings (${response.status}).`);
			const data = (await response.json()) as SettingsResponse;
			dbPath = data.dbPath ?? '';
			ziptaskBaseUrl = data.ziptaskBaseUrl ?? '';
			ziptaskEnabled = data.ziptaskEnabled ?? true;
			agentsPath = data.agentsPath ?? '';
			baseline = { dbPath, ziptaskBaseUrl, ziptaskEnabled, agentsPath };
			if (activeTab === 'opencode' && agentsPath.trim() !== '') void loadAgents();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			loading = false;
			await tick();
			dialog?.querySelector<HTMLInputElement>('input')?.focus();
		}
	}

	$effect(() => {
		const isOpen = open;
		if (isOpen && !wasOpen) {
			wasOpen = true;
			previouslyFocused =
				typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
			void load();
		} else if (!isOpen && wasOpen) {
			wasOpen = false;
			previouslyFocused?.focus();
		}
	});

	function selectTab(tab: Tab): void {
		if (tab === activeTab) return;
		activeTab = tab;
		candidates = [];
		discoveredFor = null;
		error = null;
		warning = null;
		clearNotice();
		if (tab === 'opencode' && agentsPath.trim() !== '' && !agentsLoaded && !agentsLoading) {
			void loadAgents();
		}
	}

	function onTablistKeydown(event: KeyboardEvent): void {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		const delta = event.key === 'ArrowRight' ? 1 : TAB_ORDER.length - 1;
		const next = TAB_ORDER[(TAB_ORDER.indexOf(activeTab) + delta) % TAB_ORDER.length];
		selectTab(next);
		void tick().then(() =>
			dialog?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
		);
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

	async function postJson<T>(url: string, body?: unknown): Promise<T> {
		const init: RequestInit = { method: 'POST' };
		if (body !== undefined) {
			init.headers = { 'content-type': 'application/json' };
			init.body = JSON.stringify(body);
		}
		const response = await fetch(url, init);
		if (!response.ok) {
			const data = (await response.json().catch(() => ({}))) as { error?: string };
			throw new Error(data.error ?? `Discovery failed (${response.status}).`);
		}
		return (await response.json()) as T;
	}

	function foundNotice(count: number): string {
		return `Found ${count} candidate${count === 1 ? '' : 's'} — filled the recommended value.`;
	}

	async function discover(kind: DiscoverKind): Promise<void> {
		if (discovering) return;
		discovering = true;
		error = null;
		warning = null;
		clearNotice();
		candidates = [];
		try {
			if (kind === 'opencode') {
				const value = dbPath.trim();
				const body = value.startsWith('/') ? { extraPath: value } : {};
				const data = await postJson<{ candidates: OpencodeCandidate[]; recommended: string | null }>(
					'/api/settings/discover/opencode',
					body
				);
				candidates = data.candidates.map((candidate) => ({
					value: candidate.path,
					detail: `${candidate.sessions} sessions`
				}));
				if (data.recommended !== null) dbPath = data.recommended;
				if (candidates.length > 0) showNotice(foundNotice(candidates.length));
			} else if (kind === 'ziptask') {
				const data = await postJson<{ candidates: ZiptaskCandidate[]; recommended: string | null }>(
					'/api/settings/discover/ziptask'
				);
				candidates = data.candidates.map((candidate) => ({
					value: candidate.baseUrl,
					detail: candidate.source
				}));
				if (data.recommended !== null) ziptaskBaseUrl = data.recommended;
				if (candidates.length > 0) showNotice(foundNotice(candidates.length));
			} else {
				const data = await postJson<{ candidates: AgentDirCandidate[]; recommended: string | null }>(
					'/api/settings/discover/agents'
				);
				candidates = data.candidates.map((candidate) => ({
					value: candidate.path,
					detail: `${candidate.agentCount} agent${candidate.agentCount === 1 ? '' : 's'}`
				}));
				if (data.recommended !== null) {
					agentsPath = data.recommended;
					await loadAgents();
				}
				if (candidates.length > 0) showNotice(foundNotice(candidates.length));
			}
			discoveredFor = kind;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			discovering = false;
		}
	}

	async function choose(value: string): Promise<void> {
		if (discoveredFor === 'opencode') {
			dbPath = value;
		} else if (discoveredFor === 'ziptask') {
			ziptaskBaseUrl = value;
		} else if (discoveredFor === 'agents') {
			agentsPath = value;
			await loadAgents();
		}
	}

	async function loadAgents(refresh = false): Promise<void> {
		const path = agentsPath.trim();
		if (path === '') {
			agents = [];
			agentsLoaded = false;
			agentsLoadedFor = null;
			agentsError = null;
			return;
		}
		agentsLoading = true;
		agentsError = null;
		try {
			const query = new URLSearchParams({ path });
			if (refresh) query.set('refresh', '1');
			const response = await fetch(`/api/agents?${query.toString()}`);
			if (!response.ok) {
				const data = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(data.error ?? `Could not read subagents (${response.status}).`);
			}
			const data = (await response.json()) as { dir: string; agents: AgentInfo[] };
			agents = data.agents;
			agentsLoaded = true;
			agentsLoadedFor = path;
			if (refresh) {
				showNotice(`Reloaded ${data.agents.length} subagent${data.agents.length === 1 ? '' : 's'}.`);
			}
		} catch (cause) {
			agents = [];
			agentsLoaded = false;
			agentsLoadedFor = null;
			agentsError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			agentsLoading = false;
		}
	}

	async function save(): Promise<void> {
		if (saving || !dirty) return;
		const patch: Record<string, string | boolean | null> = {};
		if (dbPath !== baseline.dbPath) patch.dbPath = dbPath.trim() === '' ? null : dbPath.trim();
		if (ziptaskBaseUrl !== baseline.ziptaskBaseUrl) {
			patch.ziptaskBaseUrl = ziptaskBaseUrl.trim() === '' ? null : ziptaskBaseUrl.trim();
		}
		if (ziptaskEnabled !== baseline.ziptaskEnabled) patch.ziptaskEnabled = ziptaskEnabled;
		if (agentsPath !== baseline.agentsPath) {
			patch.agentsPath = agentsPath.trim() === '' ? null : agentsPath.trim();
		}

		saving = true;
		error = null;
		warning = null;
		clearNotice();
		try {
			const response = await fetch('/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch)
			});
			const data = (await response.json().catch(() => ({}))) as Partial<SettingsResponse> & {
				error?: string;
			};
			if (!response.ok) {
				error = data.error ?? `Could not save settings (${response.status}).`;
				return;
			}
			dbPath = data.dbPath ?? '';
			ziptaskBaseUrl = data.ziptaskBaseUrl ?? '';
			ziptaskEnabled = data.ziptaskEnabled ?? true;
			agentsPath = data.agentsPath ?? '';
			baseline = { dbPath, ziptaskBaseUrl, ziptaskEnabled, agentsPath };
			warning = data.warning ?? null;
			showNotice('Settings saved.');
			if (agentsPath.trim() !== '' && agentsLoadedFor !== agentsPath.trim()) void loadAgents();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			saving = false;
		}
	}
</script>

{#snippet candidateList()}
	{#if candidates.length > 0}
		<ul class="candidates">
			{#each candidates as candidate (candidate.value)}
				<li>
					<button
						type="button"
						class="ui-btn ui-btn--block candidate"
						onclick={() => void choose(candidate.value)}
					>
						<span class="candidate-value">{candidate.value}</span>
						<span class="candidate-detail">{candidate.detail}</span>
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="note">{discoveredFor === null ? '' : EMPTY_NOTE[discoveredFor]}</p>
	{/if}
{/snippet}

{#snippet agentsPanel()}
	<div class="agents-panel">
		<div class="agents-head">
			<span class="agents-title">Subagents{agentsCurrent && agents.length > 0 ? ` (${agents.length})` : ''}</span>
			<button
				type="button"
				class="ui-btn refresh"
				onclick={() => void loadAgents(true)}
				disabled={agentsLoading || loading || saving}
			>
				{agentsLoading ? 'Reloading…' : 'Refresh'}
			</button>
		</div>
		{#if agentsError}
			<p class="message error" role="alert">{agentsError}</p>
		{:else if agentsCurrent && agents.length > 0}
			<ul class="agents">
				{#each agents as agent (agent.name)}
					<li class="agent">
						<span
							class="ui-swatch agent-swatch"
							style={`background: ${agent.colorVar ?? 'var(--icon-base)'}`}
							aria-hidden="true"
						></span>
						<div class="agent-main">
							<span class="agent-name">{agent.name}</span>
							{#if agent.description}<span class="agent-desc">{agent.description}</span>{/if}
						</div>
						<div class="agent-meta">
							{#if agent.mode}<span class="ui-badge agent-tag">{agent.mode}</span>{/if}
							{#if agent.color}<span class="ui-badge agent-tag">{agent.color}</span>{/if}
							{#if agent.temperature}<span class="ui-badge agent-tag">t={agent.temperature}</span>{/if}
							{#if agent.model}<span class="agent-model">{agent.model}</span>{/if}
						</div>
					</li>
				{/each}
			</ul>
		{:else if agentsCurrent}
			<p class="note">No subagents found in this folder.</p>
		{:else if !agentsLoading}
			<p class="note">Press Refresh to read the subagents folder.</p>
		{/if}
	</div>
{/snippet}

{#if open}
	<div class="ui-modal">
		<button
			type="button"
			class="ui-modal__backdrop"
			aria-label="Close settings"
			onclick={onClose}
		></button>
		<div
			class="ui-modal__dialog settings-dialog"
			id="settings-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="settings-title"
			tabindex="-1"
			bind:this={dialog}
			onkeydown={onDialogKeydown}
		>
			<header class="ui-modal__head">
				<h2 class="ui-modal__title" id="settings-title">Settings</h2>
				<button type="button" class="ui-icon-btn" aria-label="Close settings" onclick={onClose}>
					<Icon name="close" />
				</button>
			</header>

			<div
				class="tabs"
				role="tablist"
				aria-label="Settings sections"
				tabindex="-1"
				onkeydown={onTablistKeydown}
			>
				{#each TAB_ORDER as tab (tab)}
					<button
						type="button"
						role="tab"
						id={`tab-${tab}`}
						class:active={activeTab === tab}
						aria-selected={activeTab === tab}
						aria-controls={`panel-${tab}`}
						tabindex={activeTab === tab ? 0 : -1}
						onclick={() => selectTab(tab)}
					>
						{tab}
					</button>
				{/each}
			</div>

			<div class="ui-modal__body">
				<ScrollView>
					<div class="ui-modal__content panels">
						{#if error}
							<p class="message error" role="alert">{error}</p>
						{/if}
						{#if warning}
							<p class="message warning" role="status">{warning}</p>
						{/if}

						{#if activeTab === 'opencode'}
							<div id="panel-opencode" role="tabpanel" aria-labelledby="tab-opencode" tabindex="0">
								<div class="field-row">
									<label class="field">
										<span class="field-label">opencode database path</span>
										<input
											class="ui-input"
											type="text"
											bind:value={dbPath}
											placeholder="Absolute path to the opencode database"
											disabled={loading || saving}
										/>
									</label>
									<button
										type="button"
										class="ui-btn ui-btn--primary"
										onclick={() => void discover('opencode')}
										disabled={busy}
									>
										{discovering ? 'Discovering…' : 'Discover'}
									</button>
								</div>
								{#if discoveredFor === 'opencode'}{@render candidateList()}{/if}

								<div class="group">
									<div class="field-row">
										<label class="field">
											<span class="field-label">Subagents directory</span>
											<input
												class="ui-input"
												type="text"
												bind:value={agentsPath}
												placeholder="Absolute path to the subagents folder"
												disabled={loading || saving}
											/>
										</label>
										<button
											type="button"
											class="ui-btn ui-btn--primary"
											onclick={() => void discover('agents')}
											disabled={busy}
										>
											{discovering ? 'Discovering…' : 'Discover'}
										</button>
									</div>
									{#if discoveredFor === 'agents'}{@render candidateList()}{/if}
									{#if agentsPath.trim() !== ''}{@render agentsPanel()}{/if}
								</div>
							</div>
						{:else}
							<div id="panel-ziptask" role="tabpanel" aria-labelledby="tab-ziptask" tabindex="0">
								<label class="ui-checkbox">
									<input
										class="ui-checkbox__input"
										type="checkbox"
										bind:checked={ziptaskEnabled}
										disabled={loading || saving}
									/>
									<span class="field-label">Enable ziptask integration</span>
								</label>
								<p class="note">
									When off, inferred tracker links and the task detail modal are hidden.
								</p>
								<div class="field-row">
									<label class="field">
										<span class="field-label">ziptask base URL</span>
										<input
											class="ui-input"
											type="text"
											bind:value={ziptaskBaseUrl}
											placeholder="http://127.0.0.1:3005"
											disabled={loading || saving}
										/>
									</label>
									<button
										type="button"
										class="ui-btn ui-btn--primary"
										onclick={() => void discover('ziptask')}
										disabled={busy}
									>
										{discovering ? 'Discovering…' : 'Discover'}
									</button>
								</div>
								{#if discoveredFor === 'ziptask'}{@render candidateList()}{/if}
							</div>
						{/if}
					</div>
				</ScrollView>
			</div>

			<footer class="ui-modal__foot">
				{#if notice}
					<p class="ui-notice" role="status" aria-live="polite">{notice}</p>
				{/if}
				<button
					type="button"
					class="ui-btn ui-btn--primary"
					onclick={() => void save()}
					disabled={saving || loading || !dirty}
				>
					{saving ? 'Saving…' : 'Save'}
				</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	/* Size only — shape/behavior come from the global `.ui-modal` contract. */
	.settings-dialog {
		width: 50vw;
		min-width: 26rem;
		max-width: calc(100vw - 2rem);
		height: 78dvh;
		min-height: 24rem;
	}

	.tabs {
		display: flex;
		gap: var(--space-1);
		padding: 0 var(--space-4);
		border-bottom: 1px solid var(--border-weak-base);
	}

	.tabs button {
		padding: var(--space-2) var(--space-3);
		background: transparent;
		color: var(--text-weak);
		border: 0;
		border-bottom: 2px solid transparent;
		font: inherit;
		font-size: var(--font-size-small);
		cursor: pointer;
	}

	.tabs button.active {
		color: var(--text-strong);
		border-bottom-color: var(--border-selected);
	}

	[role='tabpanel'] {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.panels {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-top: var(--space-1);
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-weak-base);
	}

	.field-row {
		display: flex;
		align-items: flex-end;
		gap: var(--space-2);
	}

	.field-row .field {
		flex: 1 1 auto;
		min-width: 0;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.field-label {
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.candidates {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.candidate {
		justify-content: space-between;
		gap: var(--space-3);
		text-align: start;
	}

	.candidate-value {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.candidate-detail {
		flex: none;
		color: var(--text-faint);
		font-size: var(--font-size-small);
	}

	.agents-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-top: var(--space-1);
	}

	.agents-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.agents-title {
		font-size: var(--font-size-small);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.agents {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.agent {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		background: var(--surface-base);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
	}

	.agent-swatch {
		margin-top: var(--space-1);
	}

	.agent-main {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
		flex: 1 1 auto;
	}

	.agent-name {
		color: var(--text-strong);
		font-weight: var(--font-weight-medium);
	}

	.agent-desc {
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.agent-meta {
		flex: none;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: var(--space-1);
		max-width: 45%;
	}

	.agent-model {
		font-size: var(--font-size-small);
		color: var(--text-weak);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}

	.note {
		margin: 0;
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.message {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-small);
	}

	.message.error {
		color: var(--color-danger-strong);
		border: 1px solid var(--color-danger-border);
	}

	.message.warning {
		color: var(--text-on-warning-base);
		border: 1px solid var(--border-warning-base);
	}
</style>
