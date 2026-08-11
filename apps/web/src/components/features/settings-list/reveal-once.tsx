import type { ReactNode } from "react";
import { CopyableValue } from "@/components/copyable-value";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * One-shot secret / pubkey display. Callers compose chrome (dialog header,
 * Done footer) around this — only the copyable value + optional hint are
 * shared.
 */
export function RevealOnce({
  children,
  label,
  value,
}: {
  /** Optional hint above the copyable value (Alert body, prose, …). */
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

/** SSH-style: hint + copyable value inside an Alert. */
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
