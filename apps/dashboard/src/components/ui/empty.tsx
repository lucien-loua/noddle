import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const Empty = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed p-12 text-center text-balance",
      className
    )}
    data-slot="empty"
    {...props}
  />
);

const EmptyHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn("flex max-w-sm flex-col items-center gap-2", className)}
    data-slot="empty-header"
    {...props}
  />
);

const emptyMediaVariants = cva(
  "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground [&_svg:not([class*='size-'])]:size-5",
      },
    },
  }
);

const EmptyMedia = ({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) => (
  <div
    className={cn(emptyMediaVariants({ className, variant }))}
    data-slot="empty-icon"
    data-variant={variant}
    {...props}
  />
);

const EmptyTitle = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn("font-heading font-medium text-lg tracking-tight", className)}
    data-slot="empty-title"
    {...props}
  />
);

const EmptyDescription = ({
  className,
  ...props
}: React.ComponentProps<"p">) => (
  <div
    className={cn(
      "text-muted-foreground text-sm/relaxed [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4",
      className
    )}
    data-slot="empty-description"
    {...props}
  />
);

const EmptyContent = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex w-full min-w-0 max-w-sm flex-col items-center gap-4 text-balance text-sm",
      className
    )}
    data-slot="empty-content"
    {...props}
  />
);

export {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
};
