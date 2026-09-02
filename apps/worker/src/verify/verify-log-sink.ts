// tier: pure
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { check, cleanup, runVerify, suite } from "@noddle/testing";

import { createLogSink } from "#log-sink";

const FILE_URL = "file://";
const DEPLOYMENT_ID = "11111111-2222-4333-8444-555555555555";
const WRITTEN = "built\n";

await runVerify("log sink", async () => {
  const home = process.cwd();
  cleanup(() => process.chdir(home));

  const root = await mkdtemp(join(tmpdir(), "noddle-log-sink-"));
  cleanup(() => rm(root, { force: true, recursive: true }));

  await suite("a relative root still records a portable pointer", async () => {
    process.chdir(root);

    const sink = await createLogSink({
      deploymentId: DEPLOYMENT_ID,
      root: "logs",
    });
    sink.write(WRITTEN);
    const { byteSize, storageUrl } = await sink.close();

    check(
      "the pointer is a file:// URL",
      storageUrl.startsWith(FILE_URL),
      storageUrl
    );
    const path = storageUrl.slice(FILE_URL.length);
    check("the recorded path is absolute", isAbsolute(path), path);
    check(
      "byteSize counts what was written",
      byteSize === Buffer.byteLength(WRITTEN),
      String(byteSize)
    );

    process.chdir(tmpdir());

    const size = await stat(path)
      .then((info) => info.size)
      .catch(() => -1);
    check(
      "the archive is readable from another process' cwd",
      size === byteSize,
      `${size} bytes at ${path}`
    );

    const text = await readFile(path, "utf-8").catch(() => "");
    check("the archive holds what was streamed", text === WRITTEN, text);
  });
});
