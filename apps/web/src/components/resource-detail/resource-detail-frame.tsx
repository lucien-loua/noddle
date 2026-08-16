import type { ReactNode } from "react";

import { TeardownError } from "@/components/teardown-error";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface ResourceDetailFrameProps {
  children: ReactNode;
  deleteError?: string | null;
  subtitle: ReactNode;
  teardownError?: string | null;
}

export function ResourceDetailFrame({
  children,
  deleteError,
  subtitle,
  teardownError,
}: ResourceDetailFrameProps) {
  return (
    // `min-w-0` alongside `min-h-0`: a flex child defaults to
    // `min-width: auto`, so one long line of tool output stretches this
    // column past the viewport instead of scrolling inside it.
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="mb-3 text-muted-foreground text-sm">{subtitle}</div>
      <TeardownError message={teardownError ?? null} />
      {deleteError ? (
        <Alert className="mb-3" variant="destructive">
          <AlertDescription>{deleteError}</AlertDescription>
        </Alert>
      ) : null}
      {children}
    </div>
  );
}
