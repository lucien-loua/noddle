import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Concentric radius: inner = outer − padding.
const FOCUS_MODAL_TOKENS = [
  "[--focus-modal-radius:var(--radius-4xl)]",
  "[--focus-modal-p:--spacing(0.75)]",
  "[--focus-modal-gap:--spacing(0.75)]",
  "[--focus-modal-panel-radius:max(0px,calc(var(--focus-modal-radius)_-_var(--focus-modal-p)))]",
  "[--focus-modal-panel-px:--spacing(4)] [--focus-modal-panel-py:--spacing(4)]",
  "[--focus-modal-chrome-px:--spacing(4)] [--focus-modal-chrome-py:--spacing(2)]",
].join(" ");

const FOCUS_MODAL_PANEL =
  "relative overflow-hidden rounded-(--focus-modal-panel-radius) border border-border bg-card bg-clip-padding shadow-xs before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--focus-modal-panel-radius)-1px)] before:shadow-black/5 dark:bg-clip-border dark:before:shadow-white/5";

function FocusModal({ disablePointerDismissal = true, ...props }: DialogPrimitive.Root.Props) {
  return (
    <DialogPrimitive.Root
      data-slot="focus-modal"
      disablePointerDismissal={disablePointerDismissal}
      {...props}
    />
  );
}

function FocusModalTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="focus-modal-trigger" {...props} />;
}

function FocusModalClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="focus-modal-close" {...props} />;
}

function FocusModalPortal(props: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="focus-modal-portal" {...props} />;
}

function FocusModalOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/30 duration-100 supports-backdrop-filter:backdrop-blur-sm data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0",
        className,
      )}
      data-slot="focus-modal-overlay"
      {...props}
    />
  );
}

function FocusModalContent({
  className,
  overlayProps,
  portalProps,
  ...props
}: DialogPrimitive.Popup.Props & {
  overlayProps?: React.ComponentPropsWithoutRef<typeof FocusModalOverlay>;
  portalProps?: React.ComponentPropsWithoutRef<typeof FocusModalPortal>;
}) {
  return (
    <FocusModalPortal {...portalProps}>
      <FocusModalOverlay {...overlayProps} />
      <DialogPrimitive.Popup
        className={cn(
          FOCUS_MODAL_TOKENS,
          "fixed inset-2 z-50 flex flex-col gap-(--focus-modal-gap) overflow-hidden rounded-(--focus-modal-radius) bg-muted p-(--focus-modal-p) text-foreground shadow-xl outline-none ring-1 ring-foreground/5 dark:ring-foreground/10",
          "duration-100 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
          "origin-top data-nested-dialog-open:translate-y-[calc(var(--nested-dialogs,0)*-0.25rem)] data-nested-dialog-open:scale-[calc(1-0.025*var(--nested-dialogs,0))] data-nested-dialog-open:transition-[scale,translate] data-nested-dialog-open:duration-200 data-nested-dialog-open:ease-out",
          "after:pointer-events-none after:absolute after:inset-0 after:opacity-0 after:transition-opacity after:duration-200 data-nested-dialog-open:after:opacity-100",
          className,
        )}
        data-slot="focus-modal-popup"
        {...props}
      />
    </FocusModalPortal>
  );
}

function FocusModalHeader({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-x-3 px-(--focus-modal-chrome-px) py-(--focus-modal-chrome-py)",
        className,
      )}
      data-slot="focus-modal-header"
      {...props}
    >
      <DialogPrimitive.Close render={<Button size="icon" type="button" variant="ghost" />}>
        <XIcon weight="regular" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
      <div className="min-w-0 flex-1">{children}</div>
    </header>
  );
}

function FocusModalFooter({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <footer
      className={cn(
        "flex shrink-0 items-center justify-end gap-x-2 px-(--focus-modal-chrome-px) py-(--focus-modal-chrome-py)",
        className,
      )}
      data-slot="focus-modal-footer"
      {...props}
    >
      {children}
    </footer>
  );
}

function FocusModalTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("block truncate font-semibold text-sm", className)}
      data-slot="focus-modal-title"
      {...props}
    />
  );
}

function FocusModalDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("block truncate text-muted-foreground text-sm", className)}
      data-slot="focus-modal-description"
      {...props}
    />
  );
}

function FocusModalBody({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        FOCUS_MODAL_PANEL,
        "no-scrollbar min-h-0 flex-1 overflow-y-auto px-(--focus-modal-panel-px) py-(--focus-modal-panel-py)",
        className,
      )}
      data-slot="focus-modal-body"
      {...props}
    />
  );
}

export {
  FocusModal,
  FocusModalBody,
  FocusModalClose,
  FocusModalContent,
  FocusModalDescription,
  FocusModalFooter,
  FocusModalHeader,
  FocusModalTitle,
  FocusModalTrigger,
};
