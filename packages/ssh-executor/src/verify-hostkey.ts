// tier: pure
import { check, runVerify } from "@noddle/testing";

import { hostKeyFingerprint } from "#index";

const ED25519_BLOB =
  "AAAAC3NzaC1lZDI1NTE5AAAAIP0FeL//WeKjtfJ6cwGsyf8D4/c3LteXjBHYlZKvr63W";

const SSH_KEYGEN_SAYS = "SHA256:2Ip9UN8ffimWv5yyXQPnvUUsRjrEjhXMfKXW8jF2W1Y";

await runVerify("host key fingerprint (OpenSSH's format, exactly)", () => {
  const key = Buffer.from(ED25519_BLOB, "base64");
  const fingerprint = hostKeyFingerprint(key);

  check(
    "it matches what `ssh-keygen -lf` prints for the same key",
    fingerprint === SSH_KEYGEN_SAYS,
    fingerprint
  );
  check("it carries the SHA256 prefix", fingerprint.startsWith("SHA256:"));
  check(
    "base64 padding is stripped, as OpenSSH does",
    !fingerprint.endsWith("=")
  );

  check(
    "the same key always gives the same answer",
    hostKeyFingerprint(key) === fingerprint
  );

  const other = Buffer.from(ED25519_BLOB.replace("AAAAC3", "AAAAC4"), "base64");
  check(
    "a different key gives a different answer",
    hostKeyFingerprint(other) !== fingerprint
  );
});
