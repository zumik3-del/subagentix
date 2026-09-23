import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { apiError } from '$lib/server/http';
import { listFileBlocks } from '$lib/server/services/files';

/**
 * `GET /api/files` -> the block/file index (`{ blocks, projectsAvailable }`,
 * metadata only — never file contents). Always 200 while the process is up: a
 * missing `project` table or an unreachable DB degrades to
 * `projectsAvailable:false` with the global block still present (spec §5.1).
 */
export const GET: RequestHandler = () => {
	try {
		return json(listFileBlocks());
	} catch (cause) {
		return apiError(cause, 500);
	}
};
