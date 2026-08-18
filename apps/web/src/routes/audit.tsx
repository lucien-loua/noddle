import { LockIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { AuditTable } from "@/components/audit-table";
import { IconStack } from "@/components/icon-stack";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Frame, FramePanel } from "@/components/ui/frame";
import { getAuditLog } from "@/server/audit";
import { getAuthState } from "@/server/auth";

export const Route = createFileRoute("/audit")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: AuditPage,

  /**
   * A refusal is not a failure.
   *
   * `getAuditLog` throws from the LOADER, and an unhandled loader exception
   * renders a 500 error page: the screen announces "the server is broken"
   * when it just did exactly its job. Measured — this is what a reader saw
   * when typing /audit by hand.
   *
   * And above all, we do NOT move the decision into `beforeLoad` to dodge
   * the problem: an early redirect would mean the guard never runs, so the
   * attempt would not be RECORDED — and someone trying to reach a screen
   * they have no right to see is precisely what an audit log must capture.
   * The server refuses, the attempt is written, and the screen says so
   * politely.
   */
  errorComponent: AuditDenied,
  loader: async ({ context }) => ({
    email: context.email,
    entries: await getAuditLog(),
    role: context.role,
  }),
});

function AuditDenied() {
  return (
    <AppShell title="Audit">
      <Frame className="flex h-full min-h-0 flex-col" variant="ghost">
        <FramePanel className="flex min-h-0 flex-1 flex-col">
          <Empty className="min-h-0 flex-1 border-0">
            <EmptyHeader>
              <EmptyMedia>
                <IconStack>
                  <LockIcon className="size-5" />
                </IconStack>
              </EmptyMedia>
              <EmptyTitle>Not available for your role</EmptyTitle>
              <EmptyDescription>
                The audit log is limited to administrators. This visit was
                recorded.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </FramePanel>
      </Frame>
    </AppShell>
  );
}

function AuditPage() {
  const { email, entries, role } = Route.useLoaderData();

  return (
    <AppShell email={email} role={role} title="Audit">
      <AuditTable entries={entries} />
    </AppShell>
  );
}
