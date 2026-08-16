import { IconContext } from "@phosphor-icons/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useState } from 'react';
import type { ReactNode } from 'react';

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toast";
import { readSidebarOpen } from "@/lib/sidebar-state";

import appCss from "../styles.css?url";

/**
 * shadcn's dark theme is a CLASS, not a media query. Without this script, a
 * machine in dark mode first receives the light version and then switches —
 * the classic white flash. It runs before rendering, so the class is already
 * set by the time the first paint happens.
 *
 * Written by hand rather than imported from `lib/theme.ts`: it runs before
 * the bundle. The two are kept in sync together.
 */
/**
 * Two weights, and only two: `duotone` everywhere, `fill` where a glyph
 * marks an active or engaged state.
 *
 * Set through the context rather than repeated on every call site — the
 * default is then a single place to change, and any `weight=` left in the
 * code reads as a deliberate exception. Hoisted so the provider is not
 * handed a new object on every render.
 */
const ICON_DEFAULTS = Object.freeze({ weight: "duotone" });

const THEME_SCRIPT = `try{var t=localStorage.getItem('noddle-theme');document.documentElement.classList.toggle('dark',t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))}catch(e){}`;

export const Route = createRootRoute({
  // In the ROOT context, so every screen inherits it without a prop
  // threaded through twenty routes.
  beforeLoad: () => ({ sidebarOpen: readSidebarOpen() }),
  head: () => ({
    links: [
      { href: appCss, rel: "stylesheet" },
      { href: "/favicon.svg", rel: "icon", type: "image/svg+xml" },
    ],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "Noddle" },
      {
        content: "Deploy from a git repo to a server you own.",
        name: "description",
      },
      { content: "noindex, nofollow", name: "robots" },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: true,
            staleTime: 5000,
          },
        },
      })
  );

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: anti-flash script, must run before paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <IconContext.Provider value={ICON_DEFAULTS}>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              {children}
              <Toaster />
            </ThemeProvider>
          </QueryClientProvider>
        </IconContext.Provider>
        <Scripts />
      </body>
    </html>
  );
}
