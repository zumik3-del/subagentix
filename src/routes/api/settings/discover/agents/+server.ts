import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { apiError } from '$lib/server/http';
import { discoverAgentDirs } from '$lib/server/agents';

/** `POST /api/settings/discover/agents` -> agent directories in standard places. */
export const POST: RequestHandler = () => {
	try {
		return json(discoverAgentDirs());
	} catch (error) {
		return apiError(error, 500);
	}
};
