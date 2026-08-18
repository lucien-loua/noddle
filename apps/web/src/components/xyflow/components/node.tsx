"use client";

import { NodeToolbar as NodeToolbarPrimitive, Position } from "@xyflow/react";
import type * as React from "react";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

function Node({ className, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn("group relative overflow-visible", className)}
      data-slot="node"
      {...props}
    />
  );
}

function NodeToolbar({
  className,
  ...props
}: React.ComponentProps<typeof NodeToolbarPrimitive>) {
  return (
    <NodeToolbarPrimitive
      className={cn(
        "flex items-center gap-1 rounded-xl bg-accent p-1 dark:bg-popover",
        className
      )}
      position={Position.Bottom}
      {...props}
    />
  );
}

function NodeContent({ ...props }: React.ComponentProps<typeof CardContent>) {
  return <CardContent data-slot="node-content" {...props} />;
}

function NodeHeader({ ...props }: React.ComponentProps<typeof CardHeader>) {
  return <CardHeader data-slot="node-header" {...props} />;
}

function NodeIcon({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg border",
        className
      )}
      data-slot="node-icon"
      {...props}
    />
  );
}

function NodeTitle({
  className,
  ...props
}: React.ComponentProps<typeof CardTitle>) {
  return (
    <CardTitle
      className={cn("user-select-none break-all", className)}
      data-slot="node-title"
      {...props}
    />
  );
}

function NodeDescription({
  className,
  ...props
}: React.ComponentProps<typeof CardDescription>) {
  return (
    <CardDescription
      className={cn("line-clamp-2 break-all text-xs", className)}
      data-slot="node-description"
      {...props}
    />
  );
}

function NodeFooter({ ...props }: React.ComponentProps<typeof CardFooter>) {
  return <CardFooter data-slot="node-footer" {...props} />;
}

function NodeAction({ ...props }: React.ComponentProps<typeof CardAction>) {
  return <CardAction data-slot="node-action" {...props} />;
}

export {
  Node,
  NodeIcon,
  NodeAction,
  NodeContent,
  NodeDescription,
  NodeFooter,
  NodeHeader,
  NodeTitle,
  NodeToolbar,
};
