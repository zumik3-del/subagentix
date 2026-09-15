/**
 * Reactive browser-timezone source (the app's only runes module).
 *
 * `format.ts` stays pure and takes the zone as data; components read
 * `clock.tz` (tracked by Svelte, so every call site re-renders on the swap) and
 * pass it down. SSR never runs `initBrowserTimeZone`, so the server and the
 * first client render both use the `'UTC'` default — matching DOM, no hydration
 * mismatch; the swap to the visitor's zone happens once in `onMount`.
 */

/** Zone shared by every timestamp call site; starts at the SSR default. */
export const clock = $state({ tz: 'UTC' });

/**
 * Resolve the visitor's IANA zone once, after hydration. Any failure
 * (unsupported `Intl`, empty or invalid zone) leaves the UTC default in place;
 * this never throws.
 */
export function initBrowserTimeZone(): void {
	try {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (tz) clock.tz = tz;
	} catch {
		// Keep UTC.
	}
}
