// Le tail des logs de build, en direct par défaut.
//
// `EventSource` plutôt qu'un fetch streamé : il gère la reconnexion tout seul,
// et il envoie les cookies de session sur la même origine — donc le flux est
// gardé par la même session que le reste.
import type { UIEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface LogStreamProps {
  deploymentId: string;
  /** Appelé quand le déploiement atteint un statut terminal. */
  onEnd?: (status: string) => void;
}

/**
 * Plafond de lignes affichées. Un build Next.js en produit des dizaines de
 * milliers ; le DOM ne tient pas, et personne ne lit la dix-millième.
 */
const MAX_LINES = 4000;

/** En deçà, un groupe de bruit coûte plus cher à replier qu'à afficher. */
const MIN_GROUP = 4;

/** Distance au bas en deçà de laquelle on considère que l'utilisateur suit. */
const PIN_THRESHOLD_PX = 40;

type LineKind = "error" | "noise" | "step";

interface Line {
  /**
   * Rang de la ligne dans le log COMPLET, pas dans la fenêtre affichée.
   *
   * C'est la clé React, et un index de tableau ne conviendrait pas : le flux
   * s'allonge par la fin pendant que la fenêtre se tronque par le début, donc
   * l'index d'une ligne donnée change à mesure que le build avance. React
   * remonterait alors des lignes qui n'ont pas bougé — à 4000 nœuds, pendant
   * qu'on lit.
   */
  id: number;
  kind: LineKind;
  text: string;
}

type Block = Line | { id: number; kind: "group"; lines: Line[] };

const ERROR_PATTERN = /\berror\b|\bfailed\b|\bERR!|^✗|\bfatal\b/i;
const STEP_PATTERN = /^[▸✓✗]/;

/**
 * Séquences de couleur ANSI.
 *
 * buildx en émet MÊME sous `--progress=plain` : sans ce nettoyage, le
 * dashboard affiche « [33m1 warning found » au lieu de « 1 warning found ».
 * Le nettoyage est ici, à l'affichage, et pas dans le puits de logs : le
 * fichier d'archive doit rester l'octet exact que la VM a produit.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: c'est précisément ESC qu'on cible
const ANSI = /\u001b\[[0-9;]*m/g;

function classify(text: string): LineKind {
  if (STEP_PATTERN.test(text)) {
    return ERROR_PATTERN.test(text) ? "error" : "step";
  }
  return ERROR_PATTERN.test(text) ? "error" : "noise";
}

function parse(text: string): Line[] {
  const raw = text.split("\n");
  const from = Math.max(0, raw.length - MAX_LINES);
  const lines: Line[] = [];
  for (let i = from; i < raw.length; i += 1) {
    const value = (raw[i] ?? "").replace(ANSI, "");
    lines.push({ id: i, kind: classify(value), text: value });
  }
  return lines;
}

/** Regroupe les suites de bruit de build en blocs repliables. */
function group(lines: Line[]): Block[] {
  const out: Block[] = [];
  let run: Line[] = [];

  const flush = () => {
    if (run.length === 0) {
      return;
    }
    if (run.length >= MIN_GROUP) {
      out.push({ id: run[0]?.id ?? 0, kind: "group", lines: run });
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const line of lines) {
    if (line.kind === "noise") {
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

export function LogStream({ deploymentId, onEnd }: LogStreamProps) {
  const [text, setText] = useState("");
  const [live, setLive] = useState(true);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // Rangé dans une ref : le parent recrée ce rappel à chaque rendu, et le
  // mettre en dépendance rouvrirait la connexion SSE à chaque fois.
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    setText("");
    setLive(true);
    pinnedRef.current = true;

    const source = new EventSource(`/api/logs/${deploymentId}`);

    source.addEventListener("chunk", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        data: string;
      };
      setText((previous) => previous + payload.data);
    });

    source.addEventListener("end", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        status: string;
      };
      setLive(false);
      source.close();
      onEndRef.current?.(payload.status);
    });

    source.onerror = () => {
      // EventSource retente tout seul. On ne ferme pas : une coupure réseau
      // pendant un build de trois minutes ne doit pas perdre le flux.
      setLive(false);
    };

    return () => source.close();
  }, [deploymentId]);

  // Suivi automatique, SAUF si l'utilisateur a remonté le fil : rien n'est
  // plus agaçant qu'un log qui vous ramène en bas pendant que vous lisez.
  useEffect(() => {
    if (text.length === 0 || !pinnedRef.current) {
      return;
    }
    const view = viewRef.current;
    // Biome infère `null` pour un `useRef` générique et croit la garde morte ;
    // la ref est bien typée `HTMLDivElement | null` et posée sur le div.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: faux positif sur useRef
    if (view) {
      view.scrollTop = view.scrollHeight;
    }
  }, [text]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
  }, []);

  const blocks = useMemo(() => group(parse(text)), [text]);

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-medium text-sm">Build logs</h2>
        <Badge variant={live ? "secondary" : "outline"}>
          {live ? "live" : "finished"}
        </Badge>
      </div>

      <div
        // Hauteur PLAFONNÉE, pas fixe : un déploiement sans log affichait
        // sinon 320 px de vide, et repoussait le reste du dashboard pour ne
        // rien montrer.
        className="scroll-fade no-scrollbar wrap-break-word max-h-80 min-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
        onScroll={handleScroll}
        ref={viewRef}
      >
        {text.length === 0 ? (
          <span className="text-muted-foreground">
            Waiting for the first line…
          </span>
        ) : null}

        {blocks.map((block) =>
          block.kind === "group" ? (
            <details key={block.id}>
              <summary className="cursor-pointer text-muted-foreground">
                {block.lines.length} build lines
              </summary>
              {block.lines.map((line) => (
                <div key={line.id}>{line.text}</div>
              ))}
            </details>
          ) : (
            <div
              className={cn(
                block.kind === "error" && "font-medium text-destructive",
                block.kind === "step" && "text-foreground"
              )}
              key={block.id}
            >
              {block.text}
            </div>
          )
        )}
      </div>
    </>
  );
}
