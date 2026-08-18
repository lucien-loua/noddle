/** Shared tab panel chrome for service, database, and stack detail pages. */
export const DETAIL_TAB_PANEL_CLASS =
  "scroll-fade no-scrollbar -mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 data-ending-style:hidden";

/** Stack detail adds top padding so log content doesn't hug the tab rail. */
export const STACK_DETAIL_TAB_PANEL_CLASS = `${DETAIL_TAB_PANEL_CLASS} pt-4`;

export const DETAIL_POLL_MS = 2000;
export const AWAITING_TIMEOUT_MS = 60_000;
