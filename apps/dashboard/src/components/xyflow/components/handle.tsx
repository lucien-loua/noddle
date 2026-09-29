"use client";

import { Handle as HandlePrimitive } from "@xyflow/react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const Handle = ({
  className,
  ...props
}: ComponentProps<typeof HandlePrimitive>) => (
  <HandlePrimitive
    isConnectable={false}
    className={cn(
      "border-border! bg-background! z-1 h-5! rounded-xs! border! bg-clip-border!",
      className
    )}
    {...props}
  />
);
