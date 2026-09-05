export const SOURCE_URL = "https://github.com/lucien-loua/noddle";

export function commitUrl(sha: string): string {
  return `${SOURCE_URL}/commit/${sha}`;
}

export function releaseUrl(version: string): string {
  return `${SOURCE_URL}/releases/tag/${version}`;
}
