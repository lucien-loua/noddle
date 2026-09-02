export interface S3Provider {
  endpoint: ((region: string) => string) | null;
  forcePathStyle: boolean;
  hint?: string;
  id: string;
  label: string;
  region: string;
}

export const S3_PROVIDERS: S3Provider[] = [
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
