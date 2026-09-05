import { useQuery } from "@tanstack/react-query";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import type { ServiceVolumeRow } from "@/server/backups/volume/volumes";

type ServiceVolumePickerProps = {
  enabled: boolean;
  onPick: (volume: ServiceVolumeRow) => void;
} & (
  | {
      error?: never;
      isError?: never;
      isLoading?: never;
      serviceId: string;
      volumes?: never;
    }
  | {
      error: unknown;
      isError: boolean;
      isLoading: boolean;
      serviceId?: never;
      volumes: ServiceVolumeRow[];
    }
);

export function ServiceVolumePicker(props: ServiceVolumePickerProps) {
  const internalQuery = useQuery({
    ...queries.serviceVolumes(props.serviceId ?? ""),
    enabled: props.enabled && props.serviceId !== undefined,
  });

  const serviceVolumes =
    props.serviceId === undefined ? props.volumes : (internalQuery.data ?? []);
  const isLoading =
    props.serviceId === undefined ? props.isLoading : internalQuery.isLoading;
  const isError =
    props.serviceId === undefined ? props.isError : internalQuery.isError;
  const queryError =
    props.serviceId === undefined ? props.error : internalQuery.error;

  return (
    <Field>
      <FieldLabel htmlFor="service-volume-picker">Volumes</FieldLabel>
      {isLoading ? (
        <div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
          <Spinner />
          Loading service volumes…
        </div>
      ) : null}
      {isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {errorMessage(queryError, "could not list service volumes")}
          </AlertDescription>
        </Alert>
      ) : null}
      {isLoading || isError ? null : (
        <Combobox
          items={serviceVolumes}
          itemToStringLabel={(v: ServiceVolumeRow) =>
            `${v.volumeName} → ${v.mountPath}`
          }
          itemToStringValue={(v: ServiceVolumeRow) => v.volumeName}
          onValueChange={(next) => {
            if (next) {
              props.onPick(next as ServiceVolumeRow);
            }
          }}
          value={null}
        >
          <ComboboxInput
            id="service-volume-picker"
            placeholder="Select a volume name"
          />
          <ComboboxContent>
            <ComboboxEmpty>No volumes found</ComboboxEmpty>
            <ComboboxList>
              {(v: ServiceVolumeRow) => (
                <ComboboxItem key={v.volumeName} value={v}>
                  <code className="text-xs">{v.volumeName}</code>
                  <span className="text-muted-foreground">
                    {" "}
                    → {v.mountPath}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      )}
      <FieldDescription>
        Choose the volume to back up. If you do not see the volume here, you can
        type the volume name manually below.
      </FieldDescription>
    </Field>
  );
}
