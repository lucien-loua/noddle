import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Toggle for a value hidden by default — password, connection URL
 * carrying a password, etc. Shared by database credential cards so the
 * eye button, aria labels, and default-hidden policy can't drift.
 */
export function useReveal(initial = false): {
  revealed: boolean;
  toggle: () => void;
} {
  const [revealed, setRevealed] = useState(initial);
  const toggle = useCallback(() => setRevealed((v) => !v), []);
  return { revealed, toggle };
}

export function RevealToggleButton({
  noun,
  onClick,
  revealed,
}: {
  /** What is being revealed — "password", "URL" — for aria-label. */
  noun: string;
  onClick: () => void;
  revealed: boolean;
}) {
  return (
    <Button
      aria-label={revealed ? `Hide the ${noun}` : `Reveal the ${noun}`}
      onClick={onClick}
      size="icon-sm"
      variant="outline"
    >
      {revealed ? <EyeSlashIcon /> : <EyeIcon />}
    </Button>
  );
}
