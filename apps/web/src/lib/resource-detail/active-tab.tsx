import { Suspense } from "react";
import type { ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";

function TabFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <Spinner className="size-5" />
    </div>
  );
}

export function ActiveTabPanel({
  active,
  children,
  value,
}: {
  active: string;
  children: ReactNode;
  value: string;
}) {
  if (active !== value) {
    return null;
  }
  return <Suspense fallback={<TabFallback />}>{children}</Suspense>;
}
