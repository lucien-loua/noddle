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
    <div className="h-9 max-w-full shrink-0 rounded-full bg-muted p-1">
      <div className="scroll-fade-x no-scrollbar h-full overflow-x-auto">
        <TabsList className="h-full bg-transparent p-0">{children}</TabsList>
      </div>
    </div>
  );
}
