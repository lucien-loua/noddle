import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ChangeEvent } from "react";
import { useCallback, useState } from "react";

import { CopyButton } from "@/components/copyable-value";
import {
  RevealToggleButton,
  useReveal,
} from "@/components/features/database/reveal-secret";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import { setDatabaseExternalPort } from "@/server/databases";

export function DatabaseExternal({
  canEdit,
  canReadSecrets,
  databaseId,
  defaultPort,
  externalPort,
}: {
  canEdit: boolean;
  canReadSecrets: boolean;
  databaseId: string;
  defaultPort: number;
  externalPort: number | null;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [value, setValue] = useState(
    externalPort === null ? "" : String(externalPort)
  );
  const [error, setError] = useState<string | null>(null);
  const { revealed, toggle: toggleReveal } = useReveal();

  const credentials = useQuery({
    ...queries.databaseCredentials(databaseId),
    enabled: canReadSecrets && externalPort !== null,
  });

  const save = useMutation({
    mutationFn: () =>
      setDatabaseExternalPort({
        data: {
          databaseId,
          externalPort: value.trim() === "" ? null : Number(value),
        },
      }),
    onError: (e: Error) => setError(errorMessage(e, "could not save")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries();
      await router.invalidate();
    },
  });

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
    []
  );
  const handleSave = useCallback(() => save.mutate(), [save]);

  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>External credentials</FrameTitle>
        <FrameDescription>
          To reach this database from outside the server, publish a port. Make
          sure nothing else already uses it.
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <Field>
          <FieldLabel htmlFor="external-port">
            External port (internet)
          </FieldLabel>
          <InputGroup>
            <InputGroupInput
              disabled={!canEdit}
              id="external-port"
              inputMode="numeric"
              onChange={handleChange}
              placeholder={String(defaultPort)}
              value={value}
            />
            {canEdit ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  disabled={save.isPending}
                  onClick={handleSave}
                  size="xs"
                  variant="outline"
                >
                  {save.isPending ? <Spinner data-icon="inline-start" /> : null}
                  Save
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          {externalPort === null ? (
            <FieldDescription>
              Not published. Reachable only from services on this server.
            </FieldDescription>
          ) : null}
        </Field>

        {credentials.data?.externalConnectionUrl &&
        credentials.data.maskedExternalConnectionUrl ? (
          <Item className="mt-3" variant="muted">
            <ItemContent className="min-w-0">
              <ItemTitle>External connection URL</ItemTitle>
              <ItemDescription className="break-all font-mono">
                {revealed
                  ? credentials.data.externalConnectionUrl
                  : credentials.data.maskedExternalConnectionUrl}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <RevealToggleButton
                noun="URL"
                onClick={toggleReveal}
                revealed={revealed}
              />
              <CopyButton
                label="external connection URL"
                value={credentials.data.externalConnectionUrl}
              />
            </ItemActions>
          </Item>
        ) : null}

        {error ? (
          <Alert className="mt-3" variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </FramePanel>
    </Frame>
  );
}
