import type { ReactNode } from "react";

import { CopyableValue } from "@/components/copyable-value";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function RevealOnce({
  children,
  label,
  value,
}: {
  children?: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 space-y-2">
      {children}
      <CopyableValue label={label} value={value} />
    </div>
  );
}

export function RevealOnceAlert({
  children,
  label,
  value,
}: {
  children: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Alert>
      <AlertDescription className="min-w-0">
        <RevealOnce label={label} value={value}>
          {children}
        </RevealOnce>
      </AlertDescription>
    </Alert>
  );
}
