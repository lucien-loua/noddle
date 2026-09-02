import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";

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
