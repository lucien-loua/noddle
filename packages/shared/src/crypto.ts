// Chiffrement des secrets au repos : clés SSH, valeurs de variables
// d'environnement, URL de webhooks.
//
// AES-256-GCM. Le GCM est authentifié : toute altération du chiffré est
// détectée au déchiffrement plutôt que de produire du clair corrompu — ce qui,
// pour une clé SSH, se traduirait par un échec de connexion incompréhensible.
//
// Règle absolue : ne JAMAIS journaliser une valeur déchiffrée, ne jamais la
// renvoyer par une server function. Le déchiffrement se fait au plus près de
// l'usage, dans le worker, juste avant d'ouvrir la connexion.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, la taille recommandée pour GCM
const TAG_BYTES = 16;

/** Préfixe de version : permet de changer d'algorithme sans casser l'existant. */
const VERSION = "v1";

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

/**
 * Charge et valide APP_KEY.
 *
 * Générer avec :  openssl rand -base64 32
 *
 * Échoue bruyamment plutôt que de dériver silencieusement une clé faible d'une
 * chaîne trop courte : une clé mal formée doit empêcher le démarrage, pas
 * produire des secrets déchiffrables.
 */
export function loadAppKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new CryptoError(
      "APP_KEY absente. Générer avec : openssl rand -base64 32"
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(
      `APP_KEY doit faire ${KEY_BYTES} octets une fois décodée en base64, reçu ${key.length}. Générer avec : openssl rand -base64 32`
    );
  }
  return key;
}

/**
 * `aad` lie le chiffré à son emplacement (par ex. `env_var:<id>`).
 *
 * Sans cette liaison, quelqu'un ayant un accès en écriture à la base pourrait
 * recopier la clé SSH chiffrée d'un serveur dans la valeur d'une variable
 * d'environnement, puis la lire en clair via l'interface. Avec, le
 * déchiffrement échoue : le contexte fait partie de ce qui est authentifié.
 */
export interface SecretContext {
  aad: string;
}

export function encryptSecret(
  plaintext: string,
  key: Buffer,
  ctx: SecretContext
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(ctx.aad, "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(
  payload: string,
  key: Buffer,
  ctx: SecretContext
): string {
  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new CryptoError("chiffré malformé");
  }
  const [version, ivB64, tagB64, ctB64] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION) {
    throw new CryptoError(`version de chiffrement inconnue : ${version}`);
  }

  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoError("IV ou tag d'authentification de taille invalide");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(ctx.aad, "utf8"));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Message volontairement identique quelle que soit la cause : mauvaise clé,
    // mauvais contexte ou chiffré altéré. Distinguer les cas renseignerait un
    // attaquant sur ce qu'il doit corriger — et rattacher l'erreur d'origine
    // via `cause` la ferait ressortir dans les logs, ce qu'on veut éviter.
    // biome-ignore lint/style/useErrorCause: la cause est masquée exprès
    throw new CryptoError(
      "déchiffrement impossible : clé, contexte ou données invalides"
    );
  }
}

/**
 * Comparaison à temps constant, pour les secrets qu'on compare au lieu de les
 * déchiffrer — jetons de webhook, par exemple. `===` sur une chaîne s'arrête au
 * premier octet différent et fuit la longueur du préfixe correct.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Contextes AAD normalisés. Les construire ailleurs invite l'incohérence. */
export const secretContext = {
  envVar: (envVarId: string): SecretContext => ({ aad: `env_var:${envVarId}` }),
  serverSshKey: (serverId: string): SecretContext => ({
    aad: `server_ssh_key:${serverId}`,
  }),
} as const;
