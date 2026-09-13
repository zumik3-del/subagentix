import { listDirectories, listRecentRootSessions } from '$lib/server/queries/sessions';
import type { LayoutServerLoad } from './$types';

/** First page of sessions per sidebar directory (the client pages the rest). */
const SIDEBAR_PAGE_SIZE = 30;

/**
 * Seed the shell's session sidebar with the directory tree plus the first
 * directory's first session page, pre-expanded, so SSR renders a populated
 * tree (task #212). Directories are newest-first; later directory pages and
 * search results are fetched from `/api/sessions`.
 *
 * The sidebar must never take a page down: when the data layer is unavailable
 * the page loader owns the 503 (ADR §4.5) and the sidebar ships `null` so the
 * client shows its own error state.
 */
export const load: LayoutServerLoad = () => {
	try {
		const directories = listDirectories();
		const first = directories[0]?.directory ?? null;
		return {
			sidebar: {
				directories,
				directory: first,
				sessions: first === null ? [] : listRecentRootSessions(SIDEBAR_PAGE_SIZE, first),
				limit: SIDEBAR_PAGE_SIZE
			}
		};
	} catch {
		return { sidebar: null };
	}
};
