import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { normaliseTaskDetail } from '$lib/model/tracker';
import { resolveZiptaskBaseUrl, resolveZiptaskEnabled } from '$lib/server/settings';

/**
 * Server-side proxy for ziptask's experimental `GET /api/task/:id`.
 *
 * The modal fetches this route, never the ziptask host directly: the base URL
 * stays server-side and the browser avoids a cross-origin request. Upstream
 * 400/404 errors are passed through; anything else becomes 502.
 */

const TIMEOUT_MS = 5000;

function upstreamError(body: unknown, fallback: string): string {
	if (body !== null && typeof body === 'object') {
		const message = (body as { error?: unknown }).error;
		if (typeof message === 'string' && message !== '') return message;
	}
	return fallback;
}

export const GET: RequestHandler = async ({ params }) => {
	if (!resolveZiptaskEnabled()) {
		return json({ error: 'Not found.' }, { status: 404 });
	}
	const base = resolveZiptaskBaseUrl();
	if (base === null) {
		return json({ error: 'ZIPTASK_BASE_URL is not configured.' }, { status: 503 });
	}

	const url = `${base.replace(/\/+$/, '')}/api/task/${encodeURIComponent(params.id)}`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return json({ error: `Could not reach ziptask: ${message}` }, { status: 502 });
	}

	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		if (response.status === 400 || response.status === 404) {
			return json({ error: upstreamError(body, `Unknown task "${params.id}".`) }, { status: response.status });
		}
		return json({ error: upstreamError(body, `ziptask responded ${response.status}.`) }, { status: 502 });
	}

	const detail = normaliseTaskDetail(body);
	if (detail === null) {
		return json({ error: 'Unexpected response from ziptask.' }, { status: 502 });
	}
	return json(detail);
};
