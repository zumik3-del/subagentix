import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listDirectories } from '$lib/server/queries/sessions';
import { apiError } from '$lib/server/http';

/** `GET /api/directories` -> `DirectorySummary[]`, newest activity first. */
export const GET: RequestHandler = () => {
	try {
		return json(listDirectories());
	} catch (cause) {
		return apiError(cause);
	}
};
