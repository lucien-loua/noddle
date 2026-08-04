// Trois niveaux parce que `scroll-fade-x` est un `mask-image` : posé sur
// `TabsList`, il ronge la pastille elle-même. Décor, puis zone masquée, puis
// liste transparente.
import type { FocusEvent, ReactNode } from "react";
import { useCallback } from "react";
import { TabsList } from "@/components/ui/tabs";

export function TabRail({ children }: { children: ReactNode }) {
  // Base UI déplace le focus au clavier avec `preventScroll`, donc le rail ne
  // suivait pas : la flèche atteignait le dernier onglet 23 px hors du bord.
  const keepInView = useCallback((event: FocusEvent<HTMLDivElement>) => {
    event.target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  return (
    <div className="w-fit max-w-full shrink-0 rounded-full bg-muted p-1">
      {/* `overflow-y-hidden` n'est pas redondant : un axe en `auto` force
          l'autre de `visible` à `auto`. `-m-1 p-1` rend à l'anneau de focus
          les 4 px qu'il déborde, `scroll-px-10` la largeur du fondu. */}
      <div className="scroll-fade-x no-scrollbar -m-1 scroll-px-10 overflow-x-auto overflow-y-hidden p-1">
        {/* Hauteur reprise AVEC son préfixe : `tabsListVariants` la pose en
            `group-data-horizontal/tabs:h-9`, que `h-7` nu ne bat pas. */}
        <TabsList
          className="bg-transparent p-0 group-data-horizontal/tabs:h-7"
          onFocus={keepInView}
        >
          {children}
        </TabsList>
      </div>
    </div>
  );
}
