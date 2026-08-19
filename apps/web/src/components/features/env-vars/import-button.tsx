import { UploadSimpleIcon } from "@phosphor-icons/react";
import { useCallback, useRef } from "react";
import type { ChangeEvent } from "react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

import { parseEnvPaste } from "./parse-env-paste";
import type { EnvPair } from "./parse-env-paste";

/** A `.env` is a few hundred bytes. Anything past this is the wrong file, and
 *  reading it whole into memory before finding that out helps nobody. */
const MAX_BYTES = 512 * 1024;

/**
 * Loads a `.env` file into the table.
 *
 * No dialog: the table's diff already stands between the file and the
 * database, so asking twice would confirm the same thing twice. Picking a
 * file fills the rows, and Save is still the only thing that writes.
 *
 * No `accept` either. Real files are named `.env.production`, `.env.local`,
 * `staging.env` — a filter tuned to one of those hides the others, and the
 * parser is what actually decides whether the contents make sense.
 */
export function EnvImportButton({
  onImport,
}: {
  onImport: (pairs: EnvPair[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePick = useCallback(() => inputRef.current?.click(), []);

  const handleChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Cleared straight away: without it, picking the SAME file again fires
      // no `change` event and the button looks broken.
      event.target.value = "";
      if (!file) {
        return;
      }
      if (file.size > MAX_BYTES) {
        toast.add({
          description: `${file.name} is ${Math.round(file.size / 1024)} KB. A .env is a few hundred bytes.`,
          title: "That file is too large",
          type: "error",
        });
        return;
      }

      const pairs = parseEnvPaste(await file.text());
      if (pairs.length === 0) {
        toast.add({
          description: `Nothing in ${file.name} reads as KEY=value.`,
          title: "No variable found",
          type: "error",
        });
        return;
      }
      // Success says nothing: the rows appear and the diff below counts them.
      onImport(pairs);
    },
    [onImport]
  );

  return (
    <>
      <Button onClick={handlePick} size="sm" variant="outline">
        <UploadSimpleIcon data-icon="inline-start" weight="regular" />
        Import .env
      </Button>
      <input
        className="hidden"
        onChange={handleChange}
        ref={inputRef}
        type="file"
      />
    </>
  );
}
