// Le rail d'onglets qui défile sans se dissoudre.
//
// `scroll-fade-x` est un `mask-image`, et un masque s'applique à TOUT
// l'élément — fond et rayon compris. Posé directement sur `TabsList`, il
// rongeait la pastille grise elle-même dès que le rail débordait : les
// onglets se retrouvaient à flotter sur un fond qui s'efface. Même défaut
// que le cadre du flux de logs, à ceci près qu'ici la pastille EST ce qui
// défile — il faut donc trois niveaux, pas deux.
//
//   pastille (fond, rayon, padding)   ← statique, jamais masquée
//     └ conteneur défilant            ← porte le masque
//         └ TabsList transparente     ← les déclencheurs
//
// Atteignable en vrai : cinq onglets font 415 px, une zone de contenu de
// téléphone en fait ~343.
import type { ReactNode } from "react";
import { TabsList } from "@/components/ui/tabs";

export function TabRail({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-full shrink-0 rounded-full bg-muted p-1">
      {/*
        `overflow-y` explicite, et ce n'est PAS redondant : dès qu'un axe passe
        en `auto`, CSS force l'autre de `visible` à `auto`. Avec le seul
        `overflow-x-auto`, le rail défilait aussi verticalement.

        Le `-my-1 py-1` rend au conteneur la place que l'anneau de focus d'un
        déclencheur déborde (3 px) : sans lui, `overflow-y` le raserait. La
        marge négative reprend ce qu'ajoute le padding, donc la pastille
        mesure toujours 36 px.
      */}
      <div className="scroll-fade-x no-scrollbar -my-1 overflow-x-auto overflow-y-hidden py-1">
        {/*
          La hauteur se reprend AVEC son préfixe de variante. `tabsListVariants`
          la pose en `group-data-horizontal/tabs:h-9` : tailwind-merge ne
          déduplique pas deux portées différentes, et la version préfixée gagne
          en spécificité. Un `h-full` nu laissait donc une liste de 36 px dans
          une boîte de 28 — coupée par le bas.
        */}
        <TabsList className="bg-transparent p-0 group-data-horizontal/tabs:h-7">
          {children}
        </TabsList>
      </div>
    </div>
  );
}
