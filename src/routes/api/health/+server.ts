import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { healthCheck, resolveDbPath } from '$lib/server/db';

export const GET: RequestHandler = () => {
	try {
		return json(healthCheck());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return json({ ok: false, dbPath: resolveDbPath(), error: message }, { status: 503 });
	}
};
