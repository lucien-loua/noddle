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
  /** `database: create` — opening a database to the world isn't a routine
   *  operation, it's a configuration change. */
  canEdit: boolean;
  /** `envVar: read` — the external URL CARRIES the password. */
  canReadSecrets: boolean;
  databaseId: string;
  /** The engine's port, shown as a placeholder: the most common choice. */
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

  // The SAME key as `DatabaseCredentials`: react-query deduplicates, so the
  // two blocks share a single request. The external URL lives HERE and not
  // there because it belongs to this section — it's this card's port that
  // makes it exist.
  const credentials = useQuery({
    ...queries.databaseCredentials(databaseId),
    enabled: canReadSecrets && externalPort !== null,
  });

  const save = useMutation({
    mutationFn: () =>
      setDatabaseExternalPort({
        data: {
          databaseId,
          // Empty = we REMOVE the publication. `null` rather than `0`: the
          // column is nullable and `null` conveys "not exposed", whereas a
          // zero would require every reader to know it's special-cased.
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
          {/* The button lives INSIDE the field, via `InputGroupAddon` — not
              placed next to it in a horizontal `Field`, which gave two
              boxes for a single control. Same shape as the password field
              in the creation dialog. */}
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
          {/* Nothing to say when a port IS published: the URL right below
              already carries the host and port, in full and copyable.
              Repeating "Reachable at …" next to it would have been a
              second source for the same information. */}
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
