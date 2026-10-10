/** JSON-decode a text blob into a record, or null when unusable. */
export function jsonRecord(text: string | null): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== 'object') return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}
