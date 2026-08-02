// Génération des labels Traefik.
//
// Paquet volontairement pur : aucune I/O, aucune dépendance. Les labels sont la
// seule chose qui décide si une requête atteint le service ou tombe en 404, et
// la Phase 0 a montré que ce 404 ne ressemble à rien — le service tourne, il est
// sain, il est sur le bon réseau, et rien n'indique la cause. Une fonction pure
// se teste sans VM.
//
// Rappels payés en Phase 0 :
//   - en Swarm, Traefik lit les labels du SERVICE, pas du conteneur
//   - loadbalancer.server.port est OBLIGATOIRE : Traefik ne devine pas le port
//   - Traefik doit être >= 3.6 pour parler à Docker 29 (API 1.24 sinon refusée)

// Hissée au niveau module : une regex littérale dans une fonction se recompile
// à chaque appel, et celle-ci est évaluée à chaque déploiement.
const RULE_UNSAFE_CHARS = /[`"'\\]/;

export interface RouteConfig {
  /**
   * Résolveur ACME. Absent en local : Let's Encrypt doit joindre le serveur
   * depuis l'internet public, ce qui est impossible sur une VM de dev.
   */
  certResolver?: string;
  /** Domaine public. Absent = pas de route exposée. */
  domain?: string;
  /** Entrypoint Traefik. `web` en HTTP, `websecure` une fois TLS actif. */
  entrypoint?: string;
  /** Port d'écoute DANS le conteneur. */
  port: number;
  /** Nom du service Swarm. Sert aussi de nom de routeur et de service Traefik. */
  serviceName: string;
}

export type TraefikLabels = Record<string, string>;

/**
 * Échappe une valeur destinée à une règle Traefik.
 *
 * La règle est du texte interprété par Traefik, pas par un shell : le risque
 * n'est pas l'exécution mais la corruption de la règle. Un backtick dans un
 * domaine la terminerait prématurément.
 */
function assertRuleSafe(domain: string): void {
  if (RULE_UNSAFE_CHARS.test(domain)) {
    throw new Error(
      `domaine invalide pour une règle Traefik : ${JSON.stringify(domain)}`
    );
  }
}

export function routeLabels(cfg: RouteConfig): TraefikLabels {
  const { serviceName, domain, port } = cfg;

  // Sans domaine, le service tourne mais n'est pas exposé. C'est un cas
  // légitime (worker, cron) — il ne faut surtout pas poser traefik.enable=true
  // avec une règle vide, Traefik router alors n'importe quoi vers lui.
  if (!domain) {
    return { "traefik.enable": "false" };
  }

  assertRuleSafe(domain);
  const entrypoint = cfg.entrypoint ?? "web";

  const labels: TraefikLabels = {
    "traefik.enable": "true",
    [`traefik.http.routers.${serviceName}.rule`]: `Host(\`${domain}\`)`,
    [`traefik.http.routers.${serviceName}.entrypoints`]: entrypoint,
    // Obligatoire en mode Swarm. Sans lui, Traefik enregistre le routeur puis
    // échoue à joindre le service, ce qui se présente comme un 502.
    [`traefik.http.services.${serviceName}.loadbalancer.server.port`]:
      String(port),
  };

  if (cfg.certResolver) {
    labels[`traefik.http.routers.${serviceName}.tls`] = "true";
    labels[`traefik.http.routers.${serviceName}.tls.certresolver`] =
      cfg.certResolver;
  }

  return labels;
}

/**
 * Labels sous la forme attendue par `docker service create --label k=v`.
 *
 * Note : sur `docker service update`, les labels ne bougent pas tout seuls. Un
 * changement de domaine doit passer par `--label-add` (et `--label-rm` pour
 * l'ancien routeur), sinon l'ancienne règle survit.
 */
export function toLabelArgs(labels: TraefikLabels): string[] {
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`);
}

/**
 * Labels à retirer quand un service change de domaine ou cesse d'être exposé.
 * Traefik indexe par nom de routeur : laisser les anciens en place garde la
 * route active.
 */
export function staleRouteLabelKeys(serviceName: string): string[] {
  return [
    `traefik.http.routers.${serviceName}.rule`,
    `traefik.http.routers.${serviceName}.entrypoints`,
    `traefik.http.routers.${serviceName}.tls`,
    `traefik.http.routers.${serviceName}.tls.certresolver`,
    `traefik.http.services.${serviceName}.loadbalancer.server.port`,
  ];
}
