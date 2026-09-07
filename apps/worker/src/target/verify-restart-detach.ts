// tier: pure
import { check, runVerify, suite } from "@noddle/testing";

import { restartCommand } from "./dashboard-domain.ts";

const plain = restartCommand(false);
const tls = restartCommand(true);
const overrides = (s: string) => s.split("docker-compose.tls.yml").length - 1;

await runVerify("control-plane restart stays detached", async () => {
  await suite("the SSH exec cannot outlive its own restart", () => {
    check("own session, out of sshd's SIGHUP reach", plain.includes("setsid"));
    check("ignores SIGHUP even if one arrives", plain.includes("nohup"));
    check("backgrounded, so the exec returns at once", /&\W*$/.test(plain));
    check(
      "stdin closed, so the channel holds nothing",
      plain.includes("< /dev/null")
    );
    check(
      "waits, so the job completes before the kill",
      /sleep [1-9]/.test(plain)
    );
  });

  await suite("it restarts the app tier and nothing else", () => {
    check("names its services", plain.includes("restart dashboard worker"));
    check("never postgres", !plain.includes("postgres"));
    check("never redis", !plain.includes("redis"));
    check("never traefik", !plain.includes("traefik"));
  });

  await suite("compose files follow the TLS setting", () => {
    check("plain install has no override", overrides(plain) === 0);
    check("https install adds exactly one", overrides(tls) === 1);
  });
});
