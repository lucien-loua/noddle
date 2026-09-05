import { CircleHalfIcon } from "@phosphor-icons/react";
import { useCallback } from "react";

import { useTheme } from "@/components/theme-provider";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import type { Theme } from "@/lib/theme";

const OPTIONS: { label: string; value: Theme }[] = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
];

export function ThemeToggle() {
  const { setTheme, theme } = useTheme();

  const choose = useCallback(
    (next: string) => setTheme(next as Theme),
    [setTheme]
  );

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <CircleHalfIcon weight="regular" />
        <span>Appearance</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup onValueChange={choose} value={theme}>
          {OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
