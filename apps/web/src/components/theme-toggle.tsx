import { CircleHalfIcon } from "@phosphor-icons/react";
import { useCallback } from "react";

import { useTheme } from "@/components/theme-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
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
    <DropdownMenu>
      {/* FIXED icon: if derived from the theme, it would cause server and
          client to diverge and React would reject the tree. */}
      <DropdownMenuTrigger render={<SidebarMenuButton tooltip="Appearance" />}>
        <CircleHalfIcon />
        <span>Appearance</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuRadioGroup onValueChange={choose} value={theme}>
          {OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
