import { s3DestinationCreateSchema, s3DestinationSchema } from "@noddle/shared/validation/backup";
import { useCallback, useMemo } from "react";
import { z } from "zod";

import { findProvider, S3_PROVIDERS } from "@/lib/s3-providers";
import type { DestinationRow } from "@/server/backups/destinations";

const providerFields = z.object({ providerId: z.string() });

export type DestinationFormValues = z.input<typeof s3DestinationSchema> &
  z.infer<typeof providerFields>;

interface SetFieldValue {
  (name: "region", value: string): void;
  (name: "forcePathStyle", value: boolean): void;
  (name: "endpoint", value: string | undefined): void;
}

export const providerSelectOptions = S3_PROVIDERS.map((p) => ({
  label: p.label,
  value: p.id,
}));

export function destinationFormSchema(editing: boolean) {
  return (editing ? s3DestinationSchema : s3DestinationCreateSchema).and(providerFields);
}

export function destinationDefaultValues(initial: DestinationRow | null): DestinationFormValues {
  if (initial) {
    return {
      accessKeyId: initial.accessKeyId,
      bucket: initial.bucket,
      endpoint: initial.endpoint,
      forcePathStyle: initial.forcePathStyle,
      name: initial.name,
      prefix: initial.prefix,
      providerId: "custom",
      region: initial.region,
      secretAccessKey: "",
    };
  }
  return {
    accessKeyId: "",
    bucket: "",
    endpoint: "",
    forcePathStyle: true,
    name: "",
    prefix: "",
    providerId: "custom",
    region: "us-east-1",
    secretAccessKey: "",
  };
}

export function toDestinationPayload(value: DestinationFormValues, id?: string) {
  return {
    accessKeyId: value.accessKeyId,
    bucket: value.bucket,
    endpoint: value.endpoint,
    forcePathStyle: value.forcePathStyle,
    id,
    name: value.name,
    prefix: value.prefix,
    region: value.region,
    secretAccessKey: value.secretAccessKey,
  };
}

export function selectProviderRegion(state: { values: { providerId: string; region?: string } }) {
  return {
    providerId: state.values.providerId,
    region: state.values.region ?? "",
  };
}

export function applyProvider(providerId: string, setFieldValue: SetFieldValue): void {
  const picked = findProvider(providerId);
  setFieldValue("region", picked.region);
  setFieldValue("forcePathStyle", picked.forcePathStyle);
  setFieldValue("endpoint", picked.endpoint ? picked.endpoint(picked.region) : "");
}

export function applyRegion(
  region: string,
  providerId: string,
  setFieldValue: SetFieldValue,
): void {
  const picked = findProvider(providerId);
  if (picked.endpoint) {
    setFieldValue("endpoint", picked.endpoint(region));
  }
}

export function endpointPlaceholder(providerId: string, region: string): string | undefined {
  const picked = findProvider(providerId);
  return picked.hint ?? picked.endpoint?.(region);
}

export function useS3DestinationForm(initial: DestinationRow | null) {
  const formSchema = useMemo(() => destinationFormSchema(initial !== null), [initial]);
  const defaultValues = useMemo(() => destinationDefaultValues(initial), [initial]);
  const toPayload = useCallback(
    (value: DestinationFormValues) => toDestinationPayload(value, initial?.id),
    [initial],
  );

  return {
    defaultValues,
    endpointPlaceholder,
    formSchema,
    providerSelectOptions,
    selectProviderRegion,
    toPayload,
  };
}
