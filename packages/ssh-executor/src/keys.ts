import ssh2 from "ssh2";

export interface KeyPair {
  /** OpenSSH format, as `ssh2` can read back to connect. */
  privateKey: string;
  /** `authorized_keys` format: `ssh-ed25519 AAAA…`. */
  publicKey: string;
}

export type KeyType = "ed25519" | "rsa";

/** 4096 and not 2048: an RSA key is chosen to be accepted by an old
 *  system, and those same systems are the ones that will live the
 *  longest with it. */
const RSA_BITS = 4096;

/**
 * A key pair.
 *
 * **ed25519 by default** — short, fast, accepted by every OpenSSH since
 * 2014. RSA stays available because the default doesn't suffice
 * everywhere: network equipment, an old forge or an internal policy may
 * refuse ed25519, and Noddle would then have no fallback to offer. Same
 * reasoning as `http` tolerated for a generic webhook — forbidding it
 * wouldn't secure anyone, it would push people to bypass Noddle.
 */
export function generateKeyPair(
  type: KeyType = "ed25519",
  comment = "noddle"
): KeyPair {
  const pair =
    type === "rsa"
      ? ssh2.utils.generateKeyPairSync("rsa", { bits: RSA_BITS, comment })
      : ssh2.utils.generateKeyPairSync("ed25519", { comment });
  return { privateKey: pair.private, publicKey: pair.public };
}

/**
 * The public part of a PASTED private key.
 *
 * Without it, an imported key couldn't serve as a deploy key: we'd have
 * the half that opens, without the half you give GitHub. Returns `null`
 * rather than throwing if the key is unreadable or passphrase-protected —
 * the caller has something better to say on screen than ssh2's message.
 */
export function publicKeyOf(privateKey: string): string | null {
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) {
    return null;
  }
  return `${parsed.type} ${parsed.getPublicSSH().toString("base64")}`;
}
