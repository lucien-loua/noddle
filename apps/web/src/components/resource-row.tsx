// UNE ligne, pour tout ce que Noddle liste : service, pile, base, serveur.
//
// Avant, chaque type avait sa propre mise en forme — trois traitements de
// titre et deux façons d'afficher un statut sur le même écran. Le statut
// s'encode ici exactement deux fois : la pastille (couleur, scannable en
// colonne, répond à « ça tourne ? » sans lecture) et le badge (le mot, pour
// qui ne distingue pas les couleurs). Jamais une troisième fois en texte
// libre à côté.
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { badgeVariant, dotClass, type Tone } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  /** Action de droite : Déployer, Attacher… Toujours visible, jamais dans un menu. */
  action?: ReactNode;
  /** Ce qui distingue cette ligne des autres du même groupe. Masqué sous `md`. */
  meta?: string | null;
  name: string;
  /** Ouvre le détail. Absent = ligne non dépliable (une base, un serveur). */
  onToggle?: () => void;
  secondary?: ReactNode;
  selected?: boolean;
  /** Mention discrète à côté du nom (« sous surveillance »). */
  tag?: ReactNode;
  tone: Tone;
  toneLabel: string;
}

export function ResourceRow({
  action,
  meta,
  name,
  onToggle,
  secondary,
  selected,
  tag,
  tone,
  toneLabel,
}: Props) {
  const title = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-sm">{name}</span>
        {tag}
      </span>
      {secondary ? (
        <span className="block truncate text-muted-foreground text-xs">
          {secondary}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "relative flex items-center gap-3 px-3 py-2.5 transition-colors",
        onToggle && "hover:bg-muted/40",
        selected && "bg-muted/40"
      )}
    >
      {/* `role="img"` : un span nu ne porte pas d'aria-label, et cette pastille
          est la réponse à « est-ce que ça tourne ? » pour qui ne distingue pas
          les couleurs. */}
      <span
        aria-label={toneLabel}
        className={cn("size-2 shrink-0 rounded-full", dotClass(tone))}
        role="img"
      />

      {onToggle ? (
        // `after:inset-0` étend la cible au rang ENTIER sans imbriquer un
        // bouton dans un bloc cliquable : la sémantique reste celle d'un seul
        // bouton, et les actions à droite passent au-dessus en étant
        // positionnées.
        <button
          className="min-w-0 flex-1 rounded-sm text-start after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
          onClick={onToggle}
          type="button"
        >
          {title}
        </button>
      ) : (
        <span className="min-w-0 flex-1">{title}</span>
      )}

      {/* La métadonnée cède la place avant le statut et l'action : sur un
          téléphone, « quel commit » importe moins que « ça tourne » et
          « redéployer ».

          `suppressHydrationWarning` : elle contient un temps RELATIF, calculé
          au rendu. Le serveur écrit « il y a 49 min », le client réhydrate une
          seconde plus tard et calcule « il y a 50 min ». React voyait là une
          divergence et jetait tout l'arbre pour le reconstruire — à chaque
          chargement du dashboard. C'est l'échappatoire prévue pour un
          horodatage, pas un pansement sur un vrai désaccord. */}
      {meta ? (
        <span
          className="relative hidden shrink-0 whitespace-nowrap text-muted-foreground text-xs md:inline"
          suppressHydrationWarning
        >
          {meta}
        </span>
      ) : null}

      <Badge className="relative shrink-0" variant={badgeVariant(tone)}>
        {toneLabel}
      </Badge>

      {action ? <div className="relative shrink-0">{action}</div> : null}
    </div>
  );
}

/** Le conteneur qui tient un groupe de lignes : UNE élévation, pas une carte
 *  flottante par ligne. Les coins sont portés par le conteneur, donc les
 *  lignes n'ont aucun rayon à accorder au sien. */
export function RowGroup({
  children,
  id,
  title,
}: {
  children: ReactNode;
  id?: string;
  title?: ReactNode;
}) {
  return (
    <section className="min-w-0" id={id}>
      {title ? (
        <h2 className="mb-2 px-1 font-medium text-muted-foreground text-xs">
          {title}
        </h2>
      ) : null}
      <div className="divide-y overflow-hidden rounded-xl border bg-card">
        {children}
      </div>
    </section>
  );
}
