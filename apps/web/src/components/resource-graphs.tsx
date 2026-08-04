// Les ressources d'une machine : la valeur courante, et sa forme récente.
//
// Tracées avec TanStack Charts, cohérent avec le reste de la pile (Router,
// Query, Table, Form) et ouvrant la porte aux axes et à la lecture au survol
// le jour où l'écran devra répondre à « que s'est-il passé mardi à 3 h ».
//
// **Un trou reste un trou**, et c'est la seule chose non négociable ici : une
// courbe continue au-dessus d'une période où personne ne regardait affirme
// que la machine allait bien. La bibliothèque traite `y = null` comme une
// rupture — convention héritée d'Observable Plot, dont son API reprend les
// idiomes (`lineY`, `Channel`, `curve`). On lui donne donc explicitement un
// `null` à chaque interruption plutôt que de compter sur une interpolation
// qu'on n'aurait pas demandée.
import { ChartLineIcon } from "@phosphor-icons/react";
import { lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/react-charts";
import { scaleLinear } from "d3-scale";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { MetricPoint, ServerSeries } from "@/server/metrics";

/** Au-delà, deux échantillons ne se suivent plus : la ligne doit se rompre. */
const GAP_MS = 3 * 60 * 1000;

const WIDTH = 120;
const HEIGHT = 28;

export interface GappedPoint {
  t: number;
  v: number | null;
}

/**
 * La série, avec un `null` explicite à chaque interruption.
 *
 * C'est LE mécanisme qui rend un trou visible. On n'espère pas que la
 * bibliothèque devine qu'il manque des points : dès que deux échantillons
 * sont espacés de plus de `GAP_MS`, on insère une valeur nulle entre eux, et
 * `lineY` rompt la ligne à cet endroit. Fonction pure et exportée, donc
 * vérifiable sans monter un rendu.
 */
export function withGaps<T extends { sampledAt: string }>(
  points: T[],
  value: (p: T) => number
): GappedPoint[] {
  const out: GappedPoint[] = [];

  for (const p of points) {
    const t = Date.parse(p.sampledAt);
    const previous = out.at(-1);
    if (previous && previous.v !== null && t - previous.t > GAP_MS) {
      // Posé au milieu de l'intervalle manquant : la rupture tombe là où la
      // collecte s'est arrêtée, pas collée au point suivant.
      out.push({ t: (previous.t + t) / 2, v: null });
    }
    out.push({ t, v: value(p) });
  }
  return out;
}

const readX = (d: GappedPoint) => d.t;
const readY = (d: GappedPoint) => d.v;

export function Sparkline<T extends { sampledAt: string }>({
  label,
  max,
  points,
  value,
}: {
  label: string;
  max: number;
  points: T[];
  value: (p: T) => number;
}) {
  const data = withGaps(points, value);
  if (data.length === 0) {
    return <div className="h-7 w-30" />;
  }

  return (
    <Chart
      ariaLabel={label}
      className="text-muted-foreground"
      definition={{
        // Une sparkline : pas d'axes, pas de grille, une marge d'un pixel.
        // Ce qu'on demande à cette courbe est sa FORME ; les valeurs lisibles
        // sont écrites en chiffres juste à côté.
        guides: false,
        margin: 1,
        marks: [
          lineY(data, {
            // `currentColor` plutôt que la palette catégorielle, même une
            // fois celle-ci branchée sur les jetons shadcn : `--chart-1` vaut
            // oklch(0.87 0 0), un gris très clair pensé pour des surfaces
            // pleines — illisible en trait de 1,2 px sur une carte blanche.
            // Une série UNIQUE n'est de toute façon pas catégorielle, donc
            // elle suit la couleur du texte, ici `text-muted-foreground`.
            stroke: "currentColor",
            strokeWidth: 1.2,
            x: readX,
            y: readY,
          }),
        ],
        // `x: null` est refusé — `lineY` matérialise son canal x, donc
        // l'échelle doit exister même quand l'axe est masqué. Le domaine
        // temporel, lui, est inféré des données : c'est la fenêtre affichée.
        // La FABRIQUE, pas une instance : la bibliothèque n'infère le
        // domaine que d'une fabrique, une instance gardant celui qu'elle a.
        // Passer `scaleLinear()` laissait le domaine par défaut [0, 1], donc
        // les x restaient des horodatages bruts et la courbe se traçait à
        // 2×10^14 pixels hors écran — visible seulement à l'écran, le DOM
        // ayant l'air correct.
        x: { axis: false, scale: scaleLinear },
        // Domaine FIXE, et ce n'est pas cosmétique : laissé inféré, une
        // mémoire oscillant entre 20 et 22 % dessinerait la même vague qu'une
        // machine qui sature. La forme doit rester comparable d'une ligne à
        // l'autre. `axis: false` garde l'échelle et retire l'axe visible.
        y: {
          axis: false,
          scale: scaleLinear().domain([0, max || 1]),
        },
      }}
      height={HEIGHT}
      tabIndex={-1}
      width={WIDTH}
    />
  );
}

export function MetricRow<T extends { sampledAt: string }>({
  label,
  max,
  points,
  reading,
  value,
}: {
  label: string;
  max: number;
  points: T[];
  reading: string;
  value: (p: T) => number;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="flex items-center gap-3">
        <Sparkline label={label} max={max} points={points} value={value} />
        <span className="w-16 text-right text-xs tabular-nums">{reading}</span>
      </span>
    </div>
  );
}

const pct = (ratio: number) => `${Math.round(ratio * 100)} %`;

const readLoad = (p: MetricPoint) => p.cpuLoad1;
const readMemory = (p: MetricPoint) => p.memoryUsedRatio;
const readDisk = (p: MetricPoint) => p.diskUsedRatio;

export function ResourceGraphs({ series }: { series: ServerSeries[] }) {
  if (series.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <ChartLineIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>Aucune machine</EmptyTitle>
          <EmptyDescription>
            Les ressources sont relevées toutes les minutes sur chaque serveur
            connecté.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-3">
      {series.map((s) => (
        <div className="rounded-md border p-3" key={s.serverId}>
          <div className="mb-3 flex items-center gap-2">
            <span className="font-medium text-sm">{s.serverName}</span>
            <Badge variant="outline">{s.cpuCount} cœurs</Badge>
            <ServerFreshness latest={s.latest} />
          </div>

          {s.latest ? (
            <div className="space-y-2">
              <MetricRow
                label="Charge"
                max={s.cpuCount}
                points={s.points}
                reading={s.latest.cpuLoad1.toFixed(2)}
                value={readLoad}
              />
              <MetricRow
                label="Mémoire"
                max={1}
                points={s.points}
                reading={pct(s.latest.memoryUsedRatio)}
                value={readMemory}
              />
              <MetricRow
                label="Disque"
                max={1}
                points={s.points}
                reading={pct(s.latest.diskUsedRatio)}
                value={readDisk}
              />
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              Aucun relevé sur les six dernières heures.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Depuis quand le dernier relevé date.
 *
 * Affiché parce qu'une courbe seule ne dit pas si elle est à jour : une
 * machine injoignable depuis une heure montre exactement la même forme
 * qu'une machine calme, à ceci près que la sienne s'arrête. C'est ici qu'on
 * le dit avec des mots.
 */
function ServerFreshness({ latest }: { latest: MetricPoint | null }) {
  if (!latest) {
    return <Badge variant="destructive">aucun relevé</Badge>;
  }
  const age = Date.now() - Date.parse(latest.sampledAt);
  if (age > GAP_MS) {
    return (
      <Badge variant="destructive">
        figé <RelativeTime iso={latest.sampledAt} />
      </Badge>
    );
  }
  return (
    <span className="text-muted-foreground text-xs">
      relevé <RelativeTime iso={latest.sampledAt} />
    </span>
  );
}
