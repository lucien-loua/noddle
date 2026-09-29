import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
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

const themeListeners = new Set<() => void>();

const subscribeTheme = (onChange: () => void) => {
  themeListeners.add(onChange);
  return () => {
    themeListeners.delete(onChange);
  };
};

const notifyTheme = () => {
  for (const listener of themeListeners) {
    listener();
  }
};

const serverTheme = (): Theme => "system";
const serverResolved = (): "light" | "dark" => "light";

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, serverTheme);
  const resolved = useSyncExternalStore(
    subscribeTheme,
    readResolved,
    serverResolved
  );

  const setTheme = useCallback((next: Theme) => {
    writeTheme(next);
    notifyTheme();
  }, []);

  useEffect(() => {
    if (theme !== "system") {
      return;
    }
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyTheme("system");
      notifyTheme();
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
};
