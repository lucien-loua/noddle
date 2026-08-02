// Configuration du plan de contrôle, côté serveur uniquement.
//
// Les mêmes variables que le worker, volontairement : les deux processus sont
// lancés par le même compose, et une variable de plus serait une occasion de
// plus de les désaccorder.
import { loadAppKey } from "@noddle/shared/crypto";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`variable d'environnement requise : ${name}`);
  }
  return value;
}

export const env = {
  appKey: loadAppKey(process.env.APP_KEY),
  databaseUrl: required("DATABASE_URL"),

  /**
   * Là où le worker écrit les logs de build. Le web n'y touche QUE pour relire
   * un déploiement terminé : le direct passe par Redis, jamais par le disque.
   */
  logRoot: process.env.LOG_ROOT ?? "/var/lib/noddle/logs",

  redisUrl: required("REDIS_URL"),
} as const;
