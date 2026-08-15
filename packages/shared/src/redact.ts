/**
 * Strip credentials out of any URL appearing in free text.
 *
 * Deployment logs are assembled from output nobody here controls: git,
 * nixpacks, buildx, and whatever a user's Dockerfile prints. A clone URL
 * carrying a token (`https://x-access-token:ghs_…@github.com/org/app.git`)
 * is a bearer credential that reads like a URL, and git echoes it back in
 * several of its own error messages.
 *
 * So this redacts by SHAPE rather than by matching a known secret: we do
 * not have to remember to pass the token in, and a credential we never
 * anticipated is scrubbed the same way.
 */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s@/]+(?::[^\s@/]*)?@/gi;

export function redactUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, "$1***@");
}
