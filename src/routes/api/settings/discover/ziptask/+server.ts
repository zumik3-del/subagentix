import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { apiError } from '$lib/server/http';
import { discoverZiptaskBaseUrls } from '$lib/server/discovery';

export const POST: RequestHandler = async () => {
	try {
		return json(await discoverZiptaskBaseUrls());
	} catch (error) {
		return apiError(error, 500);
	}
};
