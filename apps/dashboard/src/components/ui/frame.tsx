import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const frameVariants = cva(
  [
    "relative flex flex-col gap-(--frame-gap) rounded-(--frame-radius) bg-muted/50 px-(--frame-px) py-(--frame-py)",
    "[--frame-radius:var(--radius-2xl)]",
    "[--frame-gap:--spacing(0.75)] [--frame-panel-footer-gap:--spacing(1)] [--frame-panel-header-gap:0rem] [--frame-px:--spacing(0.75)] [--frame-py:--spacing(0.75)]",
    "[--frame-panel-footer-px-adjust:0px] [--frame-panel-footer-py-adjust:0px] [--frame-panel-header-px-adjust:0px] [--frame-panel-header-py-adjust:0px] [--frame-panel-px-adjust:0px] [--frame-panel-py-adjust:0px]",
    "[--frame-panel-footer-px:calc(var(--frame-panel-footer-px-base)_+_var(--frame-panel-footer-px-adjust))] [--frame-panel-footer-py:calc(var(--frame-panel-footer-py-base)_+_var(--frame-panel-footer-py-adjust))] [--frame-panel-header-px:calc(var(--frame-panel-header-px-base)_+_var(--frame-panel-header-px-adjust))] [--frame-panel-header-py:calc(var(--frame-panel-header-py-base)_+_var(--frame-panel-header-py-adjust))] [--frame-panel-px:calc(var(--frame-panel-px-base)_+_var(--frame-panel-px-adjust))] [--frame-panel-py:calc(var(--frame-panel-py-base)_+_var(--frame-panel-py-adjust))]",
    "[--frame-border-color:var(--color-border)] [--frame-panel-bg:var(--color-card)] [--frame-panel-border-color:var(--color-border)]",
    "[--frame-panel-radius:max(0px,calc(var(--frame-radius)_-_var(--frame-px)_-_1px))]",
  ],
  {
    defaultVariants: {
      dense: false,
      spacing: "default",
      stacked: false,
      variant: "default",
    },
    variants: {
      dense: {
        false: "",
        true: "gap-0 border-[var(--frame-border-color)] p-0 [--frame-panel-radius:var(--frame-radius)] [&:not(:has([data-slot=frame-panel-header]))_[data-slot=frame-panel]:is(:first-child)]:-mt-px [&_[data-slot=frame-panel]:last-child]:-mb-px [&_[data-slot=frame-panel]]:-mx-px [&_[data-slot=frame-panel]]:before:hidden",
      },
      spacing: {
        default:
          "[--frame-panel-footer-px-base:--spacing(4)] [--frame-panel-footer-py-base:--spacing(2)] [--frame-panel-header-px-base:--spacing(4)] [--frame-panel-header-py-base:--spacing(2)] [--frame-panel-px-base:--spacing(4)] [--frame-panel-py-base:--spacing(4)]",
        lg: "[--frame-panel-footer-px-base:--spacing(5)] [--frame-panel-footer-py-base:--spacing(2.5)] [--frame-panel-header-px-base:--spacing(5)] [--frame-panel-header-py-base:--spacing(2.5)] [--frame-panel-px-base:--spacing(5)] [--frame-panel-py-base:--spacing(5)]",
        sm: "[--frame-panel-footer-px-base:--spacing(3)] [--frame-panel-footer-py-base:--spacing(1.5)] [--frame-panel-header-px-base:--spacing(3)] [--frame-panel-header-py-base:--spacing(1.5)] [--frame-panel-px-base:--spacing(3)] [--frame-panel-py-base:--spacing(3.5)]",
        xs: "[--frame-panel-footer-px-base:--spacing(2)] [--frame-panel-footer-py-base:--spacing(0.5)] [--frame-panel-header-px-base:--spacing(2)] [--frame-panel-header-py-base:--spacing(0.5)] [--frame-panel-px-base:--spacing(2)] [--frame-panel-py-base:--spacing(2)]",
      },
      stacked: {
        false: [
          "data-[spacing=sm]:*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:mt-0.5",
          "data-[spacing=default]:*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:mt-1",
          "data-[spacing=lg]:*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:mt-2",
        ],
        true: [
          "gap-0 *:has-[+[data-slot=frame-panel]]:rounded-b-none",
          "*:has-[+[data-slot=frame-panel]]:before:hidden",
          "*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:rounded-t-none",
          "*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:border-t-0",
        ],
      },
      variant: {
        default: "border border-[var(--frame-border-color)] bg-clip-padding",
        ghost:
          "[--frame-panel-radius:max(0px,calc(var(--frame-radius)_-_var(--frame-px)))]",
        inverse:
          "border border-[var(--frame-border-color)] bg-background bg-clip-padding [--frame-panel-bg:color-mix(in_oklch,var(--color-muted)_40%,transparent)]",
      },
    },
  }
);

function Frame({
  className,
  variant,
  spacing,
  stacked,
  dense,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof frameVariants>) {
  return (
    <div
      className={cn(
        frameVariants({ dense, spacing, stacked, variant }),
        className
      )}
      data-slot="frame"
      data-spacing={spacing}
      {...props}
    />
  );
}

function FrameForm({
  className,
  variant,
  spacing,
  stacked,
  dense,
  ...props
}: React.ComponentProps<"form"> & VariantProps<typeof frameVariants>) {
  return (
    <form
      className={cn(
        frameVariants({ dense, spacing, stacked, variant }),
        className
      )}
      data-slot="frame"
      data-spacing={spacing}
      noValidate
      {...props}
    />
  );
}

function FramePanel({
  className,
  fit,
  ...props
}: React.ComponentProps<"div"> & { fit?: boolean }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-(--frame-panel-radius) border border-(--frame-panel-border-color) bg-(--frame-panel-bg) bg-clip-padding shadow-xs",
        !fit && "grow",
        "before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--frame-panel-radius)-1px)] before:shadow-black/5",
        "dark:bg-clip-border dark:before:shadow-white/5",
        "px-(--frame-panel-px) py-(--frame-panel-py)",
        className
      )}
      data-slot="frame-panel"
      {...props}
    />
  );
}

function FrameHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      className={cn(
        "flex flex-col gap-(--frame-panel-header-gap) px-(--frame-panel-header-px) py-(--frame-panel-header-py)",
        className
      )}
      data-slot="frame-panel-header"
      {...props}
    />
  );
}

function FrameTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("font-semibold text-sm", className)}
      data-slot="frame-panel-title"
      {...props}
    />
  );
}

function FrameDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="frame-panel-description"
      {...props}
    />
  );
}

function FrameFooter({ className, ...props }: React.ComponentProps<"footer">) {
  return (
    <footer
      className={cn(
        "flex flex-col gap-(--frame-panel-footer-gap) px-(--frame-panel-footer-px) py-(--frame-panel-footer-py)",
        className
      )}
      data-slot="frame-panel-footer"
      {...props}
    />
  );
}

export {
  Frame,
  FrameDescription,
  FrameForm,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
  frameVariants,
};
