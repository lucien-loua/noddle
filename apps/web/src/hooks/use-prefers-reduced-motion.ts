import { useCallback, useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Read through `useSyncExternalStore` rather than an effect: the server has no
 * media query, and a value that flips after mount is a render disagreement —
 * the class of bug that already cost a click on the progress bars. The server
 * snapshot says "no preference", hydration matches it, and React re-renders
 * once with the real answer.
 */
export function usePrefersReducedMotion(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(QUERY);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  );
}
