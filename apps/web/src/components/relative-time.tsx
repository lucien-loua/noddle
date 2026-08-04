// Un horodatage relatif, rendu sans casser l'hydratation.
//
// `relativeTime` lit `Date.now()` AU RENDU. Le serveur écrit « il y a 9 min »,
// le navigateur réhydrate une seconde plus tard et calcule « il y a 10 min ».
// React ne voit pas un horodatage, il voit un désaccord entre les deux rendus :
// il jette l'arbre entier et le reconstruit côté client. Pendant cette
// reconstruction les gestionnaires d'événements ne sont pas attachés — un
// bouton cliqué à ce moment-là s'enfonce (l'état `:active` est du CSS) sans
// rien déclencher.
//
// **C'est le mécanisme qui rendait le dialogue « Créer un compte »
// inouvrable**, et il est intermittent par construction : la divergence
// n'apparaît que si le rendu enjambe une frontière de minute, d'heure ou de
// jour. Un écran sans horodatage relatif — la liste des canaux quand elle est
// vide, par exemple — n'a jamais le problème, ce qui donnait l'illusion que le
// défaut était local au composant.
//
// `suppressHydrationWarning` est l'échappatoire PRÉVUE pour ce cas précis, pas
// un pansement sur un vrai désaccord : le contenu est censé différer, puisque
// le temps a passé entre les deux rendus. Elle est posée ICI, une fois, plutôt
// que recopiée sur chaque écran — c'est exactement l'oubli qui a coûté ce bug.
import { relativeTime } from "@/lib/format";

/**
 * L'heure exacte, pour l'infobulle.
 *
 * « il y a 3 j » répond à « est-ce récent ? » et c'est la question courante ;
 * « le 1er août à 14:32 » répond à « était-ce avant l'incident ? », qui est la
 * question qu'on se pose quand ça compte. Les deux tiennent sans encombrer,
 * l'une au survol de l'autre.
 */
function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export function RelativeTime({ iso }: { iso: string }) {
  return (
    // `<time>` plutôt qu'un `<span>` : la valeur lisible par une machine reste
    // disponible dans `dateTime` même quand le texte affiché est approximatif.
    <time dateTime={iso} suppressHydrationWarning title={absoluteTime(iso)}>
      {relativeTime(iso)}
    </time>
  );
}
