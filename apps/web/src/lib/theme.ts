export type Theme = "light" | "dark" | "system";

export const THEME_KEY = "noddle-theme";

const EDITABLE_TAG = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * The anti-flash script in `__root.tsx` reimplements this logic in one
 * line, by hand: it runs before the bundle and therefore can't import
 * anything. The two are meant to be modified together.
 */
export function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** The EFFECTIVE theme, `system` resolved. */
export function resolvedTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Text input only. Everything else is settled via `defaultPrevented`. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || EDITABLE_TAG.test(target.tagName);
}

export function writeTheme(theme: Theme): void {
  try {
    if (theme === "system") {
      localStorage.removeItem(THEME_KEY);
    } else {
      localStorage.setItem(THEME_KEY, theme);
    }
  } catch {
    // Private browsing, storage refused: the theme then applies only to
    // the current session, which is better than failing the click.
  }
  applyTheme(theme);
}
