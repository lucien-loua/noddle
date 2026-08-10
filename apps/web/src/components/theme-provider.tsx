import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  applyTheme,
  isTypingTarget,
  resolvedTheme as readResolved,
  readTheme,
  type Theme,
  writeTheme,
} from "@/lib/theme";

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
  // `system` on first render, on both sides: the server doesn't know
  // about `localStorage`, and a state read at render time would make the
  // two trees diverge.
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

  // Follow the OS live when the choice is "system". Without this,
  // toggling the system theme left the dashboard on its old appearance
  // until the next reload.
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

  // `d` toggles light/dark. `defaultPrevented` rather than a list of
  // roles: a Base UI menu's search keystroke already consumes the key.
  // `repeat`, otherwise a held-down key flickers the theme.
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
