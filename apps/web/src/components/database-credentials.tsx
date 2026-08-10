import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { ChangeDatabasePasswordDialog } from "@/components/change-database-password-dialog";
import { CopyButton } from "@/components/copyable-value";
import { Button } from "@/components/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { getDatabaseCredentials } from "@/server/databases";

export function DatabaseCredentials({
  canChangePassword,
  canRead,
  databaseId,
  databaseName,
  running,
}: {
  /** `database: create` — changing a password isn't operating what's
   *  running, it's replacing the identifier used to connect to it. */
  canChangePassword: boolean;
  /** `envVar: read` — the boundary for "read production secrets". A
   *  courtesy only: the server function re-checks it. */
  canRead: boolean;
  databaseId: string;
  databaseName: string;
  /** The password is changed INSIDE the engine: with no container running
   *  there's nothing to alter, and offering the action would lie about
   *  what's possible. Same rule as the lifecycle actions. */
  running: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const [changing, setChanging] = useState(false);
  const toggle = useCallback(() => setRevealed((v) => !v), []);
  const openChange = useCallback(() => setChanging(true), []);

  const credentials = useQuery({
    enabled: canRead,
    queryFn: () => getDatabaseCredentials({ data: { databaseId } }),
    queryKey: ["database-credentials", databaseId],
  });

  if (!canRead) {
    return null;
  }

  const { data } = credentials;

  return (
    <Frame className="mb-3" variant="ghost">
      <FrameHeader>
        <FrameTitle>Internal credentials</FrameTitle>
        <FrameDescription>
          Reachable from any service on the overlay network — never from the
          internet. Attaching the database to a service writes this connection
          string into its environment for you.
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        {credentials.isPending ? (
          <p className="text-muted-foreground text-sm">
            <Spinner data-icon="inline-start" />
            Loading…
          </p>
        ) : null}
        {credentials.isError ? (
          <p className="text-destructive text-sm">
            Could not read the credentials.
          </p>
        ) : null}
        {data ? (
          <ItemGroup className="grid gap-2 sm:grid-cols-2">
            {/* Redis has NEITHER a user NOR a named database: showing "—"
                twice would suggest information is missing, when there
                simply isn't any. The block follows the engine. */}
            {data.user ? (
              <CredentialItem label="User" value={data.user} />
            ) : null}
            {data.databaseName ? (
              <CredentialItem label="Database name" value={data.databaseName} />
            ) : null}
            <CredentialItem label="Internal host" value={data.host} />
            <CredentialItem label="Internal port" value={String(data.port)} />

            <Item className="sm:col-span-2" variant="muted">
              <ItemContent className="min-w-0">
                <ItemTitle>Password</ItemTitle>
                {/* Hidden BY DEFAULT: showing it right away would put it on
                    the screen of anyone walking by, and in every screenshot
                    of this page. Revealing it is a deliberate action. */}
                <ItemDescription className="break-all font-mono">
                  {revealed ? data.password : "••••••••••••••••"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  aria-label={
                    revealed ? "Hide the password" : "Reveal the password"
                  }
                  onClick={toggle}
                  size="icon-sm"
                  variant="outline"
                >
                  {revealed ? <EyeSlashIcon /> : <EyeIcon />}
                </Button>
                {/* Copyable even while hidden: you copy to PASTE elsewhere,
                    not to read — showing it isn't a prerequisite. */}
                <CopyButton label="database password" value={data.password} />
                {canChangePassword && running ? (
                  <Button onClick={openChange} size="sm" variant="outline">
                    Change
                  </Button>
                ) : null}
              </ItemActions>
            </Item>

            <Item className="sm:col-span-2" variant="muted">
              <ItemContent className="min-w-0">
                <ItemTitle>Connection URL</ItemTitle>
                <ItemDescription className="break-all font-mono">
                  {/* The URL CARRIES the password: it's hidden along with
                      it, otherwise revealing it would be pointless. The
                      masked form comes from the SERVER — building it here
                      with a `replace` already let the secret leak the day
                      the URL started encoding it: the search no longer
                      matched anything and the URL displayed in the clear
                      under a screen that said "hidden". */}
                  {revealed ? data.connectionUrl : data.maskedConnectionUrl}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <CopyButton label="connection URL" value={data.connectionUrl} />
              </ItemActions>
            </Item>
          </ItemGroup>
        ) : null}
      </FramePanel>
      <ChangeDatabasePasswordDialog
        databaseId={databaseId}
        databaseName={databaseName}
        onOpenChange={setChanging}
        open={changing}
      />
    </Frame>
  );
}

/**
 * A credential row: label, value, copy button.
 *
 * `ItemTitle` / `ItemDescription` / `ItemActions` — the component's
 * documented anatomy, rather than a repurposed `<dl>`. Project rule:
 * whatever exists in the preset doesn't get rewritten.
 */
function CredentialItem({ label, value }: { label: string; value: string }) {
  return (
    <Item variant="muted">
      <ItemContent className="min-w-0">
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription className="break-all font-mono">
          {value}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <CopyButton label={label.toLowerCase()} value={value} />
      </ItemActions>
    </Item>
  );
}
