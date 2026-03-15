/**
 * Append an auth token to a WebSocket URL as a query parameter.
 */
export function appendAuthToken(url: string, token: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
