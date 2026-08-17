export interface S3Provider {
  /**
   * The endpoint, computed from the region when it depends on it.
   *
   * `null` when it can't be guessed — R2 requires an account identifier.
   * In that case we deliberately do NOT fabricate a plausible URL: a
   * wrong endpoint would fail on the first backup, far from here. The
   * field stays empty and `hint` says what to put there.
   */
  endpoint: ((region: string) => string) | null;
  /** Almost every managed provider speaks the "virtual-hosted" style;
   *  self-hosted servers want the PATH style. */
  forcePathStyle: boolean;
  /** The endpoint field's placeholder, when it can't be computed. */
  hint?: string;
  id: string;
  label: string;
  region: string;
}

export const S3_PROVIDERS: S3Provider[] = [
  // First, and selected by default.
  {
    endpoint: null,
    forcePathStyle: true,
    hint: "https://s3.example.com",
    id: "custom",
    label: "Custom / self-hosted",
    region: "us-east-1",
  },
  {
    endpoint: (region) => `https://s3.${region}.amazonaws.com`,
    forcePathStyle: false,
    id: "aws",
    label: "Amazon S3",
    region: "us-east-1",
  },
  {
    endpoint: null,
    forcePathStyle: false,
    // The account identifier can't be guessed: we ask for it rather than
    // fabricating a URL that would fail on the first backup.
    hint: "https://<account-id>.r2.cloudflarestorage.com",
    id: "r2",
    label: "Cloudflare R2",
    region: "auto",
  },
  {
    endpoint: (region) => `https://s3.${region}.backblazeb2.com`,
    forcePathStyle: false,
    id: "b2",
    label: "Backblaze B2",
    region: "us-west-004",
  },
  {
    endpoint: (region) => `https://${region}.digitaloceanspaces.com`,
    forcePathStyle: false,
    id: "spaces",
    label: "DigitalOcean Spaces",
    region: "nyc3",
  },
  {
    endpoint: (region) => `https://s3.${region}.scw.cloud`,
    forcePathStyle: false,
    id: "scaleway",
    label: "Scaleway",
    region: "fr-par",
  },
  {
    endpoint: null,
    forcePathStyle: true,
    hint: "http://10.0.0.5:9000",
    id: "minio",
    label: "MinIO",
    region: "us-east-1",
  },
  // Our own development target — it's what `packages/backup-store` is
  // verified against, 12/12 on both runtimes. It deserves its place just
  // as much as MinIO: same shape (self-hosted, PATH style, port 9000 by
  // default), and listing it avoids treating it as a special case
  // reserved for people developing Noddle.
  {
    endpoint: null,
    forcePathStyle: true,
    hint: "http://localhost:9000",
    id: "rustfs",
    label: "RustFS",
    region: "us-east-1",
  },
];

export function findProvider(id: string): S3Provider {
  return (
    S3_PROVIDERS.find((p) => p.id === id) ?? (S3_PROVIDERS[0] as S3Provider)
  );
}
