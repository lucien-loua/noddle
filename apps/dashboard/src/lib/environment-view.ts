export type EnvironmentView = "resources" | "topology";

const KEY = "noddle:environment-view";

export function readEnvironmentView(): EnvironmentView | null {
  try {
    return localStorage.getItem(KEY) === "topology" ? "topology" : null;
  } catch {
    return null;
  }
}

export function writeEnvironmentView(view: EnvironmentView): void {
  try {
    localStorage.setItem(KEY, view);
  } catch {}
}
