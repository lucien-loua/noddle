import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
// Import RELATIF, pas l'alias : la déclaration `*.css?url` vient de
// `vite/client`, et un chemin passé par `paths` est résolu par TypeScript
// avant que ce joker s'applique.
import appCss from "../styles.css?url";

/**
 * Le thème sombre de shadcn est une CLASSE, pas une media query. Sans ce
 * script, une machine en thème sombre reçoit d'abord la version claire puis
 * bascule — le flash blanc classique. Il tourne avant le rendu, donc la classe
 * est déjà posée quand la première peinture arrive.
 */
const THEME_SCRIPT = `try{if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.classList.add('dark')}catch(e){}`;

export const Route = createRootRoute({
  head: () => ({
    links: [{ href: appCss, rel: "stylesheet" }],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "Noddle" },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  // Créé dans un état plutôt qu'au niveau module : en rendu serveur, un client
  // partagé entre deux requêtes ferait fuiter le cache d'un utilisateur vers
  // l'autre. Ici il n'y en a qu'un, mais l'habitude évite d'y revenir en
  // Phase 3 quand les équipes arriveront.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Un dashboard de déploiement doit dire la vérité maintenant, pas
            // il y a cinq minutes.
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
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: script anti-flash, doit s'exécuter avant la peinture */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
