// Traductions d'affichage. Pur, sans accès serveur : chargé aussi par le
// navigateur.

/** Les variantes de `Badge` de shadcn, plus l'état sain propre à Noddle. */
export type Tone = "busy" | "danger" | "neutral" | "ok";

/**
 * Les statuts que la base distingue, rendus lisibles.
 *
 * `rolled_back` et `reverted_by_watch` sont volontairement séparés, parce que
 * la différence est celle qui compte pour la confiance qu'on accorde à
 * l'outil : le premier veut dire « Swarm a refusé la bascule, l'ancienne
 * version n'a jamais cessé de servir », le second « le déploiement avait
 * réussi, puis l'application s'est mise à boucler et Noddle est intervenu ».
 */
const DEPLOYMENT_LABELS: Record<string, { label: string; tone: Tone }> = {
  building: { label: "Build en cours", tone: "busy" },
  deploying: { label: "Bascule en cours", tone: "busy" },
  failed: { label: "Échec", tone: "danger" },
  queued: { label: "En attente", tone: "neutral" },
  reverted_by_watch: { label: "Repris par la surveillance", tone: "danger" },
  rolled_back: { label: "Annulé par Swarm", tone: "danger" },
  succeeded: { label: "Déployé", tone: "ok" },
};

const SERVICE_LABELS: Record<string, { label: string; tone: Tone }> = {
  crashed: { label: "En échec", tone: "danger" },
  created: { label: "Jamais déployé", tone: "neutral" },
  deploying: { label: "Déploiement", tone: "busy" },
  running: { label: "En service", tone: "ok" },
  stopped: { label: "Arrêté", tone: "neutral" },
};

const BACKUP_LABELS: Record<string, { label: string; tone: Tone }> = {
  completed: { label: "Sauvegardée", tone: "ok" },
  failed: { label: "Échec", tone: "danger" },
  queued: { label: "En attente", tone: "neutral" },
  running: { label: "En cours", tone: "busy" },
};

/**
 * D'où vient une sauvegarde.
 *
 * « Avant restauration » mérite son propre libellé : c'est le filet pris
 * automatiquement juste avant la seule opération irréversible du produit, et
 * la retrouver dans la liste sans savoir d'où elle sort serait déroutant au
 * moment précis où l'on cherche à se rassurer.
 */
const BACKUP_KIND_LABELS: Record<string, string> = {
  manual: "Manuelle",
  pre_restore: "Avant restauration",
  scheduled: "Planifiée",
};

export function backupLabel(status: string): { label: string; tone: Tone } {
  return BACKUP_LABELS[status] ?? { label: status, tone: "neutral" };
}

export function backupKindLabel(kind: string): string {
  return BACKUP_KIND_LABELS[kind] ?? kind;
}

/** Taille d'objet, en unités que l'œil lit sans compter les chiffres. */
export function byteSize(bytes: number): string {
  if (bytes === 0) {
    return "—";
  }
  const units = ["o", "Ko", "Mo", "Go", "To"];
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

export function deploymentLabel(status: string): { label: string; tone: Tone } {
  return DEPLOYMENT_LABELS[status] ?? { label: status, tone: "neutral" };
}

export function serviceLabel(status: string): { label: string; tone: Tone } {
  return SERVICE_LABELS[status] ?? { label: status, tone: "neutral" };
}

/** Le ton d'un statut, traduit en variante de `Badge`. */
export function badgeVariant(
  tone: Tone
): "destructive" | "outline" | "secondary" {
  if (tone === "danger") {
    return "destructive";
  }
  return tone === "neutral" ? "outline" : "secondary";
}

/** La pastille de statut : c'est elle qui répond « ça tourne ? » sans lecture. */
export function dotClass(tone: Tone): string {
  if (tone === "ok") {
    return "bg-success";
  }
  if (tone === "danger") {
    return "bg-destructive";
  }
  if (tone === "busy") {
    return "bg-primary motion-safe:animate-pulse";
  }
  return "bg-muted-foreground/50";
}

const TRIGGER_LABELS: Record<string, string> = {
  manual: "manuel",
  rollback: "retour arrière",
  watch_revert: "surveillance",
  webhook: "webhook",
};

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < MINUTE) {
    return "à l'instant";
  }
  if (seconds < HOUR) {
    return `il y a ${Math.floor(seconds / MINUTE)} min`;
  }
  if (seconds < DAY) {
    return `il y a ${Math.floor(seconds / HOUR)} h`;
  }
  return `il y a ${Math.floor(seconds / DAY)} j`;
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

/** Durée d'un déploiement, quand il est terminé. */
export function duration(startIso: string, endIso: string | null): string {
  if (!endIso) {
    return "—";
  }
  const seconds = Math.round(
    (Date.parse(endIso) - Date.parse(startIso)) / 1000
  );
  if (seconds < MINUTE) {
    return `${seconds} s`;
  }
  return `${Math.floor(seconds / MINUTE)} min ${seconds % MINUTE} s`;
}

/**
 * Le message lisible d'une erreur de server function.
 *
 * Quand un validateur Zod refuse une entrée, TanStack Start propage le
 * tableau d'issues SÉRIALISÉ comme message d'erreur. Affiché tel quel, le
 * formulaire montre du JSON à l'utilisateur — constaté dans un vrai
 * navigateur sur « Discord et Slack n'acceptent que des URL https:// », qui
 * sortait entouré de crochets, de guillemets et d'un champ `code`.
 *
 * On ne peut pas corriger ça côté serveur sans renoncer à la validation
 * partagée : c'est la forme du transport. On le défait donc à l'affichage,
 * au seul endroit où quelqu'un lit.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback;
  }
  const raw = err.message.trim();
  if (!raw.startsWith("[")) {
    return raw || fallback;
  }
  try {
    const issues = JSON.parse(raw) as { message?: string }[];
    const messages = issues
      .map((i) => i.message)
      .filter((m): m is string => Boolean(m));
    return messages.length > 0 ? messages.join(" · ") : fallback;
  } catch {
    // Un message qui commence par `[` sans être du JSON : on le rend tel quel
    // plutôt que d'avaler une cause potentiellement utile.
    return raw;
  }
}
