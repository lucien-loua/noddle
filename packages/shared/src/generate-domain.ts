const MAX_APP_LABEL = 40;
const MAX_DOMAIN_LENGTH = 253;

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/** Turn a server address into an sslip.io label segment. */
export function slugServerHost(host: string): string {
  return host.replaceAll(".", "-").replaceAll(":", "-");
}

function truncateAppLabel(appName: string): string {
  return appName.length > MAX_APP_LABEL
    ? appName.slice(0, MAX_APP_LABEL)
    : appName;
}

/**
 * Build a wildcard DNS hostname that resolves to `serverHost` without manual
 * DNS. `*.sslip.io` rather than traefik.me, which has gone down.
 */
export function formatTestDomain(opts: {
  appName: string;
  hash: string;
  serverHost: string;
}): string {
  const slugIp = slugServerHost(opts.serverHost);
  const prefix = truncateAppLabel(opts.appName);
  const label = `${prefix}-${opts.hash}${slugIp === "" ? "" : `-${slugIp}`}`;
  const domain = `${label}.sslip.io`;
  if (domain.length > MAX_DOMAIN_LENGTH) {
    throw new Error("generated domain exceeds DNS length limit");
  }
  return domain;
}

export function generateTestDomain(opts: {
  appName: string;
  serverHost: string;
}): string {
  const hash = randomHex(3);
  return formatTestDomain({ ...opts, hash });
}
