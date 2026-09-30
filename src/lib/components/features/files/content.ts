/**
 * On-demand content loading for `/files` (epic #775, spec §5.3).
 *
 * `createFileContentLoader` owns the session cache keyed by `block|path`: the
 * first expand of a row issues exactly one `GET /api/files/content`, later
 * expands (including after a block collapse/remount) reuse the cached promise.
 * Only successful reads are cached, so a failed row stays retryable, and
 * `abort()` cancels every in-flight request on unmount while `reset()` (a full
 * reload) also drops the cache. `fetchFileIndex` re-reads the block listing.
 */
import type { FileContent, FileIndex } from '$lib/model/files';

export interface FileContentLoader {
	/** Resolve one file's content, fetching at most once per `block|path`. */
	load(block: string, path: string): Promise<FileContent>;
	/** Abort every in-flight request (page unmount); cached reads are untouched. */
	abort(): void;
	/** Abort in-flight requests and drop every cached read (a full reload). */
	reset(): void;
}

/** Re-read the block/file index (`GET /api/files`), bypassing the HTTP cache. */
export async function fetchFileIndex(): Promise<FileIndex> {
	const response = await fetch('/api/files', { cache: 'no-store' });
	if (!response.ok) {
		throw new Error(await errorMessage(response));
	}
	return (await response.json()) as FileIndex;
}

/** One content request; throws an `Error` carrying the server's message. */
export async function fetchFileContent(
	block: string,
	path: string,
	signal: AbortSignal
): Promise<FileContent> {
	const params = new URLSearchParams({ block, path });
	const response = await fetch(`/api/files/content?${params}`, { signal });
	if (!response.ok) {
		throw new Error(await errorMessage(response));
	}
	return (await response.json()) as FileContent;
}

/** Prefer the API's `{ error }` body; fall back to the HTTP status. */
async function errorMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === 'string' && body.error !== '') return body.error;
	} catch {
		// Non-JSON body: keep the status fallback below.
	}
	return `Could not load the file (HTTP ${response.status}).`;
}

export function createFileContentLoader(): FileContentLoader {
	const cache = new Map<string, Promise<FileContent>>();
	const controllers = new Set<AbortController>();

	function load(block: string, path: string): Promise<FileContent> {
		const key = `${block}|${path}`;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		const controller = new AbortController();
		controllers.add(controller);
		const promise = fetchFileContent(block, path, controller.signal).finally(() =>
			controllers.delete(controller)
		);
		cache.set(key, promise);
		// A failed read is not cached, so the row's retry re-fetches.
		promise.catch(() => {
			if (cache.get(key) === promise) cache.delete(key);
		});
		return promise;
	}

	function abort(): void {
		for (const controller of controllers) controller.abort();
		controllers.clear();
	}

	function reset(): void {
		abort();
		cache.clear();
	}

	return { load, abort, reset };
}
