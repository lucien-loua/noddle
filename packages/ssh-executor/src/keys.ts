import ssh2 from "ssh2";

export interface KeyPair {
  privateKey: string;
  publicKey: string;
}

export type KeyType = "ed25519" | "rsa";

const RSA_BITS = 4096;

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

export function publicKeyOf(privateKey: string): string | null {
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) {
    return null;
  }
  return `${parsed.type} ${parsed.getPublicSSH().toString("base64")}`;
}
