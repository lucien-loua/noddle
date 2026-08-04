// Les ressources d'une machine : la valeur courante, et sa forme récente.
//
// Des sparklines SVG écrites à la main plutôt qu'une bibliothèque de
// graphiques. Ce n'est pas de l'économie de dépendance pour le plaisir : la
// question posée ici est « est-ce que la machine tient ? », qui se répond
// d'un coup d'œil sur une courbe de trente pixels. Des axes, une légende et
// des infobulles serviraient à explorer, ce qui n'est pas la question — et
// contrediraient « ~4 tailles de texte, un accent ».
//
// **Un trou reste un trou.** La courbe est coupée là où la collecte a manqué,
// jamais interpolée : un segment continu au-dessus d'une période où personne
// ne regardait affirmerait que la machine allait bien.
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { relativeTime } from "@/lib/format";
import type { MetricPoint, ServerSeries } from "@/server/metrics";

/** Au-delà, deux échantillons ne se suivent plus : la ligne doit se rompre. */
const GAP_MS = 3 * 60 * 1000;

const WIDTH = 120;
const HEIGHT = 28;

/**
 * Découpe la série en segments continus.
 *
 * Chaque interruption de plus de `GAP_MS` ouvre un nouveau segment, qui sera
 * tracé séparément. C'est tout le mécanisme qui rend un trou visible.
 */
export function segments(
  points: MetricPoint[],
  value: (p: MetricPoint) => number
): { t: number; v: number }[][] {
  const out: { t: number; v: number }[][] = [];
  let current: { t: number; v: number }[] = [];

  for (const p of points) {
    const t = Date.parse(p.sampledAt);
    const previous = current.at(-1);
    if (previous && t - previous.t > GAP_MS) {
      out.push(current);
      current = [];
    }
    current.push({ t, v: value(p) });
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

function Sparkline({
  max,
  points,
  value,
}: {
  max: number;
  points: MetricPoint[];
  value: (p: MetricPoint) => number;
}) {
  const parts = segments(points, value);
  if (parts.length === 0) {
    return <div className="h-7 w-30" />;
  }

  const times = points.map((p) => Date.parse(p.sampledAt));
  const first = Math.min(...times);
  const last = Math.max(...times);
  const span = last - first || 1;
  const ceiling = max || 1;

  const x = (t: number) => ((t - first) / span) * WIDTH;
  const y = (v: number) => HEIGHT - Math.min(v / ceiling, 1) * (HEIGHT - 2) - 1;

  return (
    <svg
      aria-hidden="true"
      className="text-muted-foreground"
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
    >
      <title>Historique</title>
      {parts.map((seg) => {
        const d = seg
          .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t)},${y(p.v)}`)
          .join(" ");
        // Un segment d'un seul point ne trace rien avec `path` : on pose un
        // point, sinon un échantillon isolé disparaîtrait de l'écran.
        const single = seg.length === 1 && seg[0];
        return single ? (
          <circle
            cx={x(single.t)}
            cy={y(single.v)}
            fill="currentColor"
            key={single.t}
            r={1.2}
          />
        ) : (
          <path
            d={d}
            fill="none"
            key={seg[0]?.t}
            stroke="currentColor"
            strokeWidth={1.2}
          />
        );
      })}
    </svg>
  );
}

function Row({
  label,
  max,
  points,
  reading,
  value,
}: {
  label: string;
  max: number;
  points: MetricPoint[];
  reading: string;
  value: (p: MetricPoint) => number;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="flex items-center gap-3">
        <Sparkline max={max} points={points} value={value} />
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
        <EmptyTitle>Aucune machine</EmptyTitle>
        <EmptyDescription>
          Les ressources sont relevées toutes les minutes sur chaque serveur
          connecté.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="max-w-3xl space-y-3">
      {series.map((s) => (
        <div className="rounded-md border p-3" key={s.serverId}>
          <div className="mb-3 flex items-center gap-2">
            <span className="font-medium text-sm">{s.serverName}</span>
            <Badge variant="outline">{s.cpuCount} cœurs</Badge>
            <ServerFreshness latest={s.latest} />
          </div>

          {s.latest ? (
            <div className="space-y-2">
              <Row
                label="Charge"
                max={s.cpuCount}
                points={s.points}
                reading={s.latest.cpuLoad1.toFixed(2)}
                value={readLoad}
              />
              <Row
                label="Mémoire"
                max={1}
                points={s.points}
                reading={pct(s.latest.memoryUsedRatio)}
                value={readMemory}
              />
              <Row
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
      <Badge variant="destructive">figé {relativeTime(latest.sampledAt)}</Badge>
    );
  }
  return (
    <span className="text-muted-foreground text-xs">
      relevé {relativeTime(latest.sampledAt)}
    </span>
  );
}
