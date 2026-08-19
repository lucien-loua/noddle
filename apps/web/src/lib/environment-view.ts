/**
 * Which of an environment's two views was last chosen.
 *
 * The URL stays the source of truth — `?view=topology` always wins, so a
 * shared link opens what it says. This only answers the case the URL cannot:
 * coming BACK to an environment from a resource you opened out of the graph.
 * The breadcrumb points at the environment itself, with no search, so the
 * canvas you were reading would silently become the grid.
 *
 * Read it in an EFFECT, never while rendering: this does not exist on the
 * server, and consulting it during render makes the two renders disagree —
 * the failure that already cost a click through `Progress`.
 */
export type EnvironmentView = "resources" | "topology";

const KEY = "noddle:environment-view";

export function readEnvironmentView(): EnvironmentView | null {
  try {
    return localStorage.getItem(KEY) === "topology" ? "topology" : null;
  } catch {
    // Private mode, or storage disabled. The default view is not worth an
    // error boundary.
    return null;
  }
}

export function writeEnvironmentView(view: EnvironmentView): void {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // Same: losing the preference is not a failure worth reporting.
  }
}
