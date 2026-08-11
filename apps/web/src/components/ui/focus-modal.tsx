import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function FocusModal({
  disablePointerDismissal = true,
  ...props
}: DialogPrimitive.Root.Props) {
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

function FocusModalOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/30 duration-100 supports-backdrop-filter:backdrop-blur-sm data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0",
        className
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
          "fixed inset-2 z-50 flex flex-col overflow-hidden rounded-4xl bg-popover text-popover-foreground shadow-xl outline-none ring-1 ring-foreground/5 dark:ring-foreground/10",
          // Nested stack (Base UI `--nested-dialogs`): toast-like but subtler —
          // parent peeks up a hair and shrinks; child has no backdrop.
          "origin-top scale-[calc(1-0.035*var(--nested-dialogs,0))] translate-y-[calc(var(--nested-dialogs,0)*-0.5rem)] transition-[scale,translate,opacity] duration-200 ease-out",
          "after:pointer-events-none after:absolute after:inset-0 after:bg-black/25 after:opacity-0 after:backdrop-blur-[2px] after:transition-opacity after:duration-200 data-nested-dialog-open:after:opacity-100",
          "data-closed:fade-out-0 data-closed:zoom-out-95 data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-open:animate-in",
          className
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
    <div
      className={cn(
        "flex shrink-0 items-center gap-x-3 border-b bg-secondary/25 p-3",
        className
      )}
      data-slot="focus-modal-header"
      {...props}
    >
      <DialogPrimitive.Close
        render={<Button size="icon" type="button" variant="ghost" />}
      >
        <XIcon />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function FocusModalFooter({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end gap-x-2 border-t bg-secondary/25 p-3",
        className
      )}
      data-slot="focus-modal-footer"
      {...props}
    >
      {children}
    </div>
  );
}

function FocusModalTitle({
  className,
  ...props
}: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn(
        "block truncate font-heading font-medium text-base leading-none",
        className
      )}
      data-slot="focus-modal-title"
      {...props}
    />
  );
}

function FocusModalDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn(
        "mt-1 block truncate text-muted-foreground text-sm",
        className
      )}
      data-slot="focus-modal-description"
      {...props}
    />
  );
}

/**
 * Scrollable body of a focus modal.
 *
 * Same pattern as `DialogBody`: `min-h-0` lets the flex child shrink,
 * `scroll-fade-y` hints at more content, and `no-scrollbar` hides the bar.
 */
function FocusModalBody({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "scroll-fade-y no-scrollbar min-h-0 flex-1 overflow-y-auto",
        className
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
