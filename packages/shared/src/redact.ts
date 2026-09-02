const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s@/]+(?::[^\s@/]*)?@/gi;

export function redactUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, "$1***@");
}
