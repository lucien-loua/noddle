import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useCallback, useEffect } from "react";

import { useCopyFeedback } from "@/components/copyable-value";
import { useAppForm } from "@/components/fields/lib/form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

function selectConfirmName(state: { values: { confirmName: string } }) {
  return state.values.confirmName;
}

export function ConfirmNameDialog({
  confirmLabel,
  description,
  onConfirm,
  onOpenChange,
  open,
  pending,
  resourceName,
  title,
}: {
  confirmLabel: string;
  description: ReactNode;
  onConfirm: (typed: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pending: boolean;
  resourceName: string;
  title: ReactNode;
}) {
  const form = useAppForm({
    defaultValues: { confirmName: "" },
    onSubmit: ({ value }) => onConfirm(value.confirmName),
  });
  const { copied, handleCopy } = useCopyFeedback(resourceName);

  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [open, form.reset]);

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form.AppField name="confirmName">
          {(f) => (
            <f.FieldText
              autoComplete="off"
              label={
                <>
                  Type{" "}
                  <Badge
                    className="cursor-pointer font-mono"
                    onClick={handleCopy}
                    render={
                      <button
                        aria-label={`Copy ${resourceName}`}
                        type="button"
                      />
                    }
                    variant="outline"
                  >
                    {resourceName}
                    {copied ? (
                      <CheckIcon data-icon="inline-end" weight="regular" />
                    ) : (
                      <CopyIcon data-icon="inline-end" weight="regular" />
                    )}
                  </Badge>{" "}
                  to confirm
                  <span aria-live="polite" className="sr-only">
                    {copied ? `${resourceName} copied` : ""}
                  </span>
                </>
              }
            />
          )}
        </form.AppField>

        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <form.Subscribe selector={selectConfirmName}>
            {(typed) => (
              <Button
                disabled={typed !== resourceName || pending}
                onClick={handleSubmit}
                variant="destructive"
              >
                {pending ? <Spinner data-icon="inline-start" /> : null}
                {confirmLabel}
              </Button>
            )}
          </form.Subscribe>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
