import { listFileBlocks } from '$lib/server/services/files';
import type { PageServerLoad } from './$types';

/**
 * `/files` loader: the block/file listing (`{ blocks, projectsAvailable }`,
 * metadata only). Contents are fetched on demand from `/api/files/content`, so
 * SSR ships no file bodies.
 *
 * Mirrors the sidebar's DB-degrade pattern (`+layout.server.ts`): the global
 * config block needs no DB, so a failing data layer never 503s the page — the
 * loader returns a global-only index with `projectsAvailable:false`.
 */
export const load: PageServerLoad = () => {
	try {
		return listFileBlocks();
	} catch {
		return { blocks: [], projectsAvailable: false };
	}
};
