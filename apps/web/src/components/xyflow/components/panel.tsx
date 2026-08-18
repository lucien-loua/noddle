"use client";

import { Panel as PanelPrimitive } from "@xyflow/react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Panel({ className, ...props }: ComponentProps<typeof PanelPrimitive>) {
  return (
    <PanelPrimitive
      className={cn("m-2! min-w-0 overflow-hidden", className)}
      style={{
        zIndex: 1000,
      }}
      {...props}
    />
  );
}

export { Panel };
