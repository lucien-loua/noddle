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
        "z-1 border! h-5! rounded-xs! border-border! bg-clip-border! bg-background!",
        className
      )}
      {...props}
    />
  );
}
