import { useMutation } from "@tanstack/react-query";
import { useCallback, useId, useState } from "react";

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { FramePanel } from "@/components/ui/frame";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { setServerPruneEnabled } from "@/server/servers";

export function ServerPruneToggle({
  enabled,
  error,
  onError,
  role,
  serverId,
}: {
  enabled: boolean;
  error: string | null;
  onError: (message: string) => void;
  role: RoleName | null;
  serverId: string;
}) {
  const canUpdate = useCan(role, "server", "update");
  const [value, setValue] = useState(enabled);
  const id = useId();

  const save = useMutation({
    mutationFn: (next: boolean) => setServerPruneEnabled({ data: { enabled: next, serverId } }),
    onError: (e: Error, _next, context: { previous: boolean } | undefined) => {
      if (context) {
        setValue(context.previous);
      }
      onError(errorMessage(e, "could not save"));
    },
    onMutate: (next) => {
      const previous = value;
      setValue(next);
      return { previous };
    },
  });

  const handleChange = useCallback((next: boolean) => save.mutate(next), [save]);

  if (!canUpdate) {
    return (
      <FramePanel>
        <p className="text-muted-foreground text-sm">
          Daily prune {value ? "enabled" : "disabled"} on this server.
        </p>
      </FramePanel>
    );
  }

  return (
    <FramePanel>
      {error ? (
        <p className="mb-3 text-destructive text-sm" role="status">
          {error}
        </p>
      ) : null}

      <FieldLabel
        className="has-[>[data-slot=field]]:rounded-none has-[>[data-slot=field]]:border-0 has-data-checked:bg-transparent *:data-[slot=field]:p-0"
        htmlFor={id}
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle>Daily prune</FieldTitle>
            <FieldDescription>
              Removes stopped containers, unused images and stale build cache on this node once a
              day. This server still counts toward reconciliation and its disk usage keeps being
              read either way.
            </FieldDescription>
          </FieldContent>
          <Switch
            checked={value}
            disabled={save.isPending}
            id={id}
            onCheckedChange={handleChange}
          />
        </Field>
      </FieldLabel>
    </FramePanel>
  );
}
