/**
 * The real credential is the httpOnly session cookie — page code can never
 * read it, which is the point (XSS cannot steal it). This localStorage flag
 * is a worthless-to-attackers hint that a session probably exists, so the
 * router guard can skip rendering protected pages without a network round
 * trip. The daemon never sees it; the 401 interceptor in api.ts is the
 * actual arbiter of session validity.
 */
const MARKER_KEY = 'dormice.console.signed-in';

export function hasSessionMarker(): boolean {
  return localStorage.getItem(MARKER_KEY) !== null;
}

export function setSessionMarker(): void {
  localStorage.setItem(MARKER_KEY, '1');
}

export function clearSessionMarker(): void {
  localStorage.removeItem(MARKER_KEY);
}
