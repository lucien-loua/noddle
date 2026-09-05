import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { CopyButton } from "@/components/copyable-value";
import { ChangeDatabasePasswordDialog } from "@/components/features/database/change-password-dialog";
import {
  RevealToggleButton,
  useReveal,
} from "@/components/features/database/reveal-secret";
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
import { queries } from "@/lib/queries";

export function DatabaseCredentials({
  canChangePassword,
  canRead,
  databaseId,
  databaseName,
  running,
}: {
  canChangePassword: boolean;
  canRead: boolean;
  databaseId: string;
  databaseName: string;
  running: boolean;
}) {
  const { revealed, toggle } = useReveal();
  const [changing, setChanging] = useState(false);
  const openChange = useCallback(() => setChanging(true), []);

  const credentials = useQuery({
    ...queries.databaseCredentials(databaseId),
    enabled: canRead,
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
          Reachable from any service on the overlay network, never from the
          internet.
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
                <ItemDescription className="break-all font-mono">
                  {revealed ? data.password : "••••••••••••••••"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <RevealToggleButton
                  noun="password"
                  onClick={toggle}
                  revealed={revealed}
                />
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
