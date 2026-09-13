import { json } from '@sveltejs/kit';
import { isAbsolute } from 'node:path';
import type { RequestHandler } from './$types';
import { apiError, invalidRequest } from '$lib/server/http';
import { discoverOpencodeDbs } from '$lib/server/discovery';

export const POST: RequestHandler = async ({ request }) => {
	const text = await request.text();
	let extraPaths: string[] = [];
	if (text.trim() !== '') {
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return invalidRequest('Request body must be a JSON object.');
		}
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			return invalidRequest('Request body must be a JSON object.');
		}
		const extra = (body as Record<string, unknown>).extraPath;
		if (extra !== undefined) {
			if (typeof extra !== 'string' || extra.trim() === '' || !isAbsolute(extra)) {
				return invalidRequest('extraPath must be a non-empty absolute path.', 'extraPath');
			}
			extraPaths = [extra];
		}
	}

	try {
		return json(discoverOpencodeDbs({ extraPaths }));
	} catch (error) {
		return apiError(error, 500);
	}
};
