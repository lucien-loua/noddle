/**
 * biome-ignore-all lint/performance/noJsxPropsBind: dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  FocusModal,
  FocusModalBody,
  FocusModalContent,
  FocusModalDescription,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { byteSize, errorMessage, relativeTime } from "@/lib/format";
import { queries } from "@/lib/queries";
import type { BackupObjectRow, DestinationRow } from "@/server/backups";
import { ServiceVolumePicker } from "./service-volume-picker";

function ObjectsListBody({
  destinationId,
  error,
  isError,
  isLoading,
  objects,
  onPick,
  volumeName,
}: {
  destinationId: string;
  error: unknown;
  isError: boolean;
  isLoading: boolean;
  objects: BackupObjectRow[] | undefined;
  onPick: (
    destinationId: string,
    objectKey: string,
    volumeName: string
  ) => void;
  volumeName: string;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {errorMessage(error, "could not list objects")}
        </AlertDescription>
      </Alert>
    );
  }

  const rows = objects ?? [];
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No volume archives under this destination prefix.
      </p>
    );
  }

  const restoreDisabled = volumeName.trim() === "";

  return (
    <div className="min-w-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Modified</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((obj) => (
            <TableRow key={obj.key}>
              <TableCell className="max-w-70 truncate font-mono text-xs">
                {obj.key}
              </TableCell>
              <TableCell className="text-xs tabular-nums">
                {byteSize(obj.sizeBytes)}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {obj.lastModified ? relativeTime(obj.lastModified) : "—"}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  disabled={restoreDisabled}
                  onClick={() =>
                    onPick(destinationId, obj.key, volumeName.trim())
                  }
                  size="sm"
                  variant="outline"
                >
                  Restore
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function VolumeRestoreFromS3Dialog({
  defaultVolumeName,
  destinations,
  onOpenChange,
  onPick,
  open,
  serviceId,
}: {
  defaultVolumeName?: string;
  destinations: DestinationRow[];
  onOpenChange: (open: boolean) => void;
  onPick: (
    destinationId: string,
    objectKey: string,
    volumeName: string
  ) => void;
  open: boolean;
  serviceId: string;
}) {
  const [firstDestination] = destinations;
  const [destinationId, setDestinationId] = useState(
    firstDestination ? firstDestination.id : ""
  );
  const [volumeName, setVolumeName] = useState(defaultVolumeName ?? "");

  useEffect(() => {
    if (!open) {
      return;
    }
    if (defaultVolumeName) {
      setVolumeName(defaultVolumeName);
    }
  }, [open, defaultVolumeName]);

  const objects = useQuery({
    ...queries.backupObjects(destinationId),
    enabled: open && Boolean(destinationId),
  });

  const selected = destinations.find((d) => d.id === destinationId) ?? null;

  return (
    <FocusModal onOpenChange={onOpenChange} open={open}>
      <FocusModalContent>
        <FocusModalHeader>
          <div className="min-w-0">
            <FocusModalTitle>Restore from destination</FocusModalTitle>
            <FocusModalDescription>
              Pick a tar.gz archive already in the bucket. Noddle scales the
              service down before writing into the target volume.
            </FocusModalDescription>
          </div>
        </FocusModalHeader>
        <FocusModalBody className="flex min-h-0 flex-col gap-4 overflow-hidden p-4">
          <Field className="shrink-0">
            <FieldLabel>Destination</FieldLabel>
            <Combobox
              items={destinations}
              itemToStringLabel={(d: DestinationRow) => d.name}
              itemToStringValue={(d: DestinationRow) => d.name}
              onValueChange={(next) => {
                if (!next) {
                  setDestinationId("");
                  return;
                }
                setDestinationId((next as DestinationRow).id);
              }}
              value={selected}
            >
              <ComboboxInput placeholder="Choose a destination" />
              <ComboboxContent>
                <ComboboxEmpty>No destination matches.</ComboboxEmpty>
                <ComboboxList>
                  {(d: DestinationRow) => (
                    <ComboboxItem key={d.id} value={d}>
                      {d.name}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </Field>

          <ServiceVolumePicker
            enabled={open}
            onPick={(volume) => setVolumeName(volume.volumeName)}
            serviceId={serviceId}
          />

          <Field className="shrink-0">
            <FieldLabel>Volume name</FieldLabel>
            <Input
              onChange={(e) => setVolumeName(e.target.value)}
              placeholder="hello-data-abc123"
              value={volumeName}
            />
            <FieldDescription>
              The name of the Docker volume to restore into.
            </FieldDescription>
          </Field>

          <div className="scroll-fade-y no-scrollbar min-h-0 flex-1 overflow-y-auto">
            <ObjectsListBody
              destinationId={destinationId}
              error={objects.error}
              isError={objects.isError}
              isLoading={objects.isLoading}
              objects={objects.data}
              onPick={onPick}
              volumeName={volumeName}
            />
          </div>
        </FocusModalBody>
      </FocusModalContent>
    </FocusModal>
  );
}
