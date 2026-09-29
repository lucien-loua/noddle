import { useSyncExternalStore } from "react";

const NOW_TICK_MS = 15_000;

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

const tick = () => {
  now = Date.now();
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(tick, NOW_TICK_MS);
  }
  return () => {
    listeners.delete(onChange);
  };
};

const getSnapshot = () => now;

const getServerSnapshot = () => null;

export function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
