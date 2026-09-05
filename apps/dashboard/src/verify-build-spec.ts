// tier: pure
import { services } from "@noddle/db/schema";
import {
  BUILD_SPEC_FIELDS,
  buildSpecOf,
  SERVICE_IDENTITY_FIELDS,
} from "@noddle/shared/build-spec";
import { check, runVerify } from "@noddle/testing";
import { getTableColumns } from "drizzle-orm";

const columns = Object.keys(getTableColumns(services)).toSorted();
const spec = [...BUILD_SPEC_FIELDS] as string[];
const identity = [...SERVICE_IDENTITY_FIELDS] as string[];

await runVerify("service build spec", () => {
  const classified = [...spec, ...identity].toSorted();

  const unclassified = columns.filter((c) => !classified.includes(c));
  check(
    "every services column is classified as build spec or identity",
    unclassified.length === 0,
    `unclassified: ${unclassified.join(", ")} — decide whether a Preview inherits it`
  );

  const stale = classified.filter((c) => !columns.includes(c));
  check(
    "no classified field has disappeared from the schema",
    stale.length === 0,
    `stale: ${stale.join(", ")}`
  );

  const overlap = spec.filter((c) => identity.includes(c));
  check(
    "a field is one or the other, never both",
    overlap.length === 0,
    `both: ${overlap.join(", ")}`
  );

  for (const field of [
    "publishDirectory",
    "registryId",
    "watchPaths",
    "autoDeploy",
  ]) {
    check(`${field} is inherited by a copy`, spec.includes(field));
  }

  for (const field of ["id", "name", "environmentId", "status"]) {
    check(`${field} is NOT inherited`, identity.includes(field));
  }

  const parent = Object.fromEntries(
    columns.map((c) => [c, `value-of-${c}`])
  ) as Record<string, unknown>;
  const picked = buildSpecOf(
    parent as Parameters<typeof buildSpecOf>[0]
  ) as Record<string, unknown>;

  check(
    "buildSpecOf picks exactly the build spec, and every field of it",
    Object.keys(picked).toSorted().join(",") === [...spec].toSorted().join(",")
  );
  check(
    "buildSpecOf carries the values through untouched",
    spec.every((f) => picked[f] === `value-of-${f}`)
  );
});
