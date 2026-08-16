import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The BUTTON alone, without the box.
 *
 * Extracted from `CopyableValue` when the credentials block moved onto
 * `Item`: there the box is the preset component's own (`Item
 * variant="muted"`) and the button goes into `ItemActions`, so reusing
 * `CopyableValue` wholesale nested a box inside a box. What must NOT be
 * duplicated is everything around the clipboard action: the visual
 * feedback, its delay, and the voice announcement — hence extracting it
 * rather than writing a second button next to it.
 */
/**
 * The state and the gesture alone, with no rendering at all — for a trigger
 * that isn't `CopyButton` itself (a clickable name badge in a confirmation
 * dialog, for example). Extracted rather than copied: the delay before
 * reverting to the initial state is the constant that must stay identical
 * everywhere.
 */
export function useCopyFeedback(value: string) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }, [value]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return { copied, handleCopy };
}

export function CopyButton({
  className,
  label,
  value,
}: {
  className?: string;
  /** What's being copied, for the `aria-label` and the announcement:
   *  "Copy public key". */
  label: string;
  value: string;
}) {
  const { copied, handleCopy } = useCopyFeedback(value);

  return (
    <>
      <Button
        aria-label={`Copy ${label}`}
        className={cn("shrink-0", className)}
        onClick={handleCopy}
        size="icon-sm"
        variant="outline"
      >
        {copied ? <CheckIcon weight="regular" /> : <CopyIcon />}
      </Button>
      {/* `aria-live`: the checkmark alone says nothing to whoever can't see
          it, and confirming that action is exactly the point. */}
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} copied` : ""}
      </span>
    </>
  );
}

export function CopyableValue({
  className,
  label,
  value,
}: {
  className?: string;
  label: string;
  value: string;
}) {
  return (
    <>
      {/* `items-start` and not `items-center`: a single-line value — a
          password — makes no difference, but a 4096-bit RSA key spans
          eighteen, and the button used to end up suspended in the middle of
          the block, far from anything. Aligned to the top, it stays on the
          first line regardless of height. */}
      <div
        className={cn(
          "flex items-start gap-2 rounded-2xl bg-muted p-2",
          className
        )}
      >
        {/* `min-w-0` + `break-all`: without both, a single long word value —
            a public key runs 80 characters with no spaces — widens the box
            instead of fitting inside it, and overflows the dialog.
            Measured. */}
        <code className="min-w-0 flex-1 break-all px-1 font-mono text-xs">
          {value}
        </code>
        <CopyButton label={label} value={value} />
      </div>
    </>
  );
}
