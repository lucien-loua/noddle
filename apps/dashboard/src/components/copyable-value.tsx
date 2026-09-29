import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/secure-context";
import { cn } from "@/lib/utils";

export function useCopyFeedback(value: string) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await copyText(value);
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

export const CopyButton = ({
  className,
  label,
  value,
}: {
  className?: string;
  label: string;
  value: string;
}) => {
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
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} copied` : ""}
      </span>
    </>
  );
};

export const CopyableValue = ({
  className,
  label,
  value,
}: {
  className?: string;
  label: string;
  value: string;
}) => (
  <div
    className={cn("bg-muted flex items-start gap-2 rounded-2xl p-2", className)}
  >
    <code className="min-w-0 flex-1 px-1 font-mono text-xs break-all">
      {value}
    </code>
    <CopyButton label={label} value={value} />
  </div>
);
