import { UploadSimpleIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

import { parseEnvPaste } from "./parse-env-paste";
import type { EnvPair } from "./parse-env-paste";

/**
 * Importing a whole `.env`, said out loud.
 *
 * Pasting a blob into a row already worked, and nothing announced it: you had
 * to guess that the table would split what you pasted rather than store it as
 * one enormous value. The same parser now has a door with its name on it, and
 * the paste shortcut still works for whoever found it.
 */
export function EnvImportDialog({
  onImport,
}: {
  onImport: (pairs: EnvPair[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const pairs = parseEnvPaste(text);

  const handleImport = useCallback(() => {
    onImport(parseEnvPaste(text));
    setText("");
    setOpen(false);
  }, [onImport, text]);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setText("");
    }
  }, []);

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <UploadSimpleIcon data-icon="inline-start" weight="regular" />
        Import .env
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import .env</DialogTitle>
          <DialogDescription>
            Paste the file. Comments, export prefixes and quotes are stripped. A
            key already in the table keeps its place and takes the new value.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="env-import">File contents</FieldLabel>
          <Textarea
            className="min-h-40 font-mono text-xs"
            id="env-import"
            onChange={(e) => setText(e.target.value)}
            placeholder={"DATABASE_URL=postgres://…\nPORT=3000"}
            spellCheck={false}
            value={text}
          />
        </Field>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          {/* The count is the confirmation: it says what the parser UNDERSTOOD,
              before anything is written. Nothing to import keeps it disabled
              rather than letting a silent no-op look like success. */}
          <Button disabled={pairs.length === 0} onClick={handleImport}>
            {pairs.length === 0
              ? "Import"
              : `Import ${pairs.length} variable${pairs.length > 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
