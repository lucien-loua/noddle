export const SAFE_SHELL_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function assertSafeShellIdentifier(value: string, label: string): void {
  if (!SAFE_SHELL_IDENTIFIER.test(value)) {
    throw new Error(
      `${label} is not safe for shell use: "${value}". Use letters, digits, underscore, dot and hyphen only`
    );
  }
}
