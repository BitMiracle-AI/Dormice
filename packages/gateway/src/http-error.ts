/**
 * An error that carries its HTTP status. Handlers throw it; the app's
 * global error handler turns it into the protocol's `{ message }` body
 * with this status code.
 */
export function httpError(
  statusCode: number,
  message: string,
): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
