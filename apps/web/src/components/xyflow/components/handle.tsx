"use client";

import { Handle as HandlePrimitive } from "@xyflow/react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Handle({
  className,
  ...props
}: ComponentProps<typeof HandlePrimitive>) {
  return (
    <HandlePrimitive
      isConnectable={false}
      className={cn(
        "border! h-5! w-3! rounded-sm! border-border! bg-clip-border! bg-secondary! transition",
        className
      )}
      {...props}
    />
  );
}
