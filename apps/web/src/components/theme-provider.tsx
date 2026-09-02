import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";

import {
  applyTheme,
  isTypingTarget,
  resolvedTheme as readResolved,
  readTheme,
  writeTheme,
} from "@/lib/theme";
import type { Theme } from "@/lib/theme";

interface ThemeContextValue {
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
  theme: Theme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = use(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }
  return value;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  useEffect(() => {
    setThemeState(readTheme());
    setResolved(readResolved());
  }, []);

  const setTheme = useCallback((next: Theme) => {
    writeTheme(next);
    setThemeState(next);
    setResolved(readResolved());
  }, []);

  useEffect(() => {
    if (theme !== "system") {
      return;
    }
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyTheme("system");
      setResolved(readResolved());
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key?.toLowerCase() !== "d" || isTypingTarget(event.target)) {
        return;
      }
      setTheme(readResolved() === "dark" ? "light" : "dark");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setTheme]);

  const value = useMemo(
    () => ({ resolvedTheme: resolved, setTheme, theme }),
    [resolved, setTheme, theme]
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
