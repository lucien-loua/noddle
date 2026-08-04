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
import type { FocusEvent, ReactNode } from "react";
import { useCallback } from "react";
import { TabsList } from "@/components/ui/tabs";

export function TabRail({ children }: { children: ReactNode }) {
  /**
   * Ramène dans la vue le déclencheur qui vient de prendre le focus.
   *
   * Le navigateur le ferait seul, mais Base UI déplace le focus au clavier
   * avec `preventScroll` — sinon chaque flèche ferait sauter la PAGE. Mesuré
   * sans ce rappel : les flèches atteignaient bien le dernier onglet, la zone
   * restait à `scrollLeft` 0, et le focus se posait 23 px au-delà du bord
   * droit. C'est-à-dire invisible.
   *
   * `nearest` sur les deux axes : le minimum qui rende l'onglet entier: on ne
   * veut ni recentrer le rail à chaque flèche, ni faire défiler la page
   * verticalement pour un mouvement horizontal.
   */
  const keepInView = useCallback((event: FocusEvent<HTMLDivElement>) => {
    event.target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  return (
    <div className="max-w-full shrink-0 rounded-full bg-muted p-1">
      {/*
        `overflow-y` explicite, et ce n'est PAS redondant : dès qu'un axe passe
        en `auto`, CSS force l'autre de `visible` à `auto`. Avec le seul
        `overflow-x-auto`, le rail défilait aussi verticalement.

        Le `-m-1 p-1` rend au conteneur la place que l'anneau de focus d'un
        déclencheur déborde — 3 px d'anneau plus 1 px de contour, sur les
        QUATRE côtés : le premier déclencheur touche le bord de la zone
        défilante, donc un padding seulement vertical le rasait quand même à
        gauche. La marge négative reprend ce qu'ajoute le padding, donc la
        pastille mesure toujours 36 px.

        `scroll-px-10` vaut la largeur du fondu (`min(12%, 40px)`), et c'est
        `scrollIntoView` ci-dessus qui l'honore : sans lui l'onglet s'arrêterait
        pile sous le dégradé — focus posé sur un onglet à moitié effacé.
      */}
      <div className="scroll-fade-x no-scrollbar -m-1 scroll-px-10 overflow-x-auto overflow-y-hidden p-1">
        {/*
          La hauteur se reprend AVEC son préfixe de variante. `tabsListVariants`
          la pose en `group-data-horizontal/tabs:h-9` : tailwind-merge ne
          déduplique pas deux portées différentes, et la version préfixée gagne
          en spécificité. Un `h-full` nu laissait donc une liste de 36 px dans
          une boîte de 28 — coupée par le bas.
        */}
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
