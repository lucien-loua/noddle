// tier: pure
// bun run packages/ssh-credentials/src/verify.ts
import { encryptSecret, loadAppKey, secretContext } from "@noddle/crypto";
import { check, expectThrows, runVerify } from "@noddle/testing";

import { credentialsFromKey } from "./index.ts";

const KEY = loadAppKey(Buffer.alloc(32).toString("base64"));
const KEY_ID = "key-verify-1";
const PEM =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----";

await runVerify("ssh-credentials", () => {
  const server = {
    host: "10.0.0.1",
    sshKeyId: KEY_ID,
    sshPort: 2222,
    sshUser: "deploy",
  };
  const box = encryptSecret(PEM, KEY, secretContext.sshKey(KEY_ID));

  const creds = credentialsFromKey(KEY, server, {
    id: KEY_ID,
    privateKeyEncrypted: box,
  });

  check(
    "maps host / port / user",
    creds.host === "10.0.0.1" && creds.port === 2222 && creds.user === "deploy"
  );
  check("decrypts the library private key", creds.privateKey === PEM);

  expectThrows("wrong AAD key id refuses to decrypt", () =>
    credentialsFromKey(KEY, server, {
      id: "other-id",
      privateKeyEncrypted: box,
    })
  );
});
