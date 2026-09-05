import { IconContext } from "@phosphor-icons/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toast";
import { TAGLINE } from "@/lib/brand";
import { readSidebarOpen } from "@/lib/sidebar-state";

import appCss from "../styles.css?url";

const ICON_DEFAULTS = Object.freeze({ weight: "duotone" });

const THEME_SCRIPT = `try{var t=localStorage.getItem('noddle-theme');document.documentElement.classList.toggle('dark',t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))}catch(e){}`;

export const Route = createRootRoute({
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
      { content: TAGLINE, name: "description" },
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
        {/* oxlint-disable-next-line react/no-danger -- anti-flash script, must run before paint */}
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
