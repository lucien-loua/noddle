import type { ReactNode } from "react";

import { TeardownError } from "@/components/teardown-error";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface ResourceDetailFrameProps {
  children: ReactNode;
  deleteError?: string | null;
  subtitle: ReactNode;
  teardownError?: string | null;
}

export const ResourceDetailFrame = ({
  children,
  deleteError,
  subtitle,
  teardownError,
}: ResourceDetailFrameProps) => (
  <div className="flex h-full min-h-0 min-w-0 flex-col">
    <div className="text-muted-foreground mb-3 text-sm">{subtitle}</div>
    <TeardownError message={teardownError ?? null} />
    {deleteError ? (
      <Alert className="mb-3" variant="destructive">
        <AlertDescription>{deleteError}</AlertDescription>
      </Alert>
    ) : null}
    {children}
  </div>
);
