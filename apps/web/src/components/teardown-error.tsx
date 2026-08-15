import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * The headline of a failure, and the rest only if asked for.
 *
 * A build failure carries the tail of whatever tool died — buildkit layer
 * numbers, nix store paths, a Dockerfile excerpt. Rendered whole it filled
 * the top of the page with red text nobody reads, and buried the one line
 * that says what happened. The full output already lives in the build logs;
 * this is a summary, not a second copy of them.
 */
export function TeardownError({ message }: { message: string | null }) {
  const [open, setOpen] = useState(false);

  if (!message) {
    return null;
  }

  const trimmed = message.trim();
  const [headline = trimmed, ...rest] = trimmed.split("\n");
  const detail = rest.join("\n").trim();

  return (
    <Alert className="mb-3" variant="destructive">
      <AlertTitle className="wrap-anywhere">{headline}</AlertTitle>
      {detail ? (
        <AlertDescription>
          <Collapsible onOpenChange={setOpen} open={open}>
            <CollapsibleTrigger
              render={
                <Button size="sm" variant="ghost">
                  {open ? "Hide details" : "Show details"}
                </Button>
              }
            />
            <CollapsibleContent>
              {/* Monospace and scrollable: it is tool output, and it must
                  not stretch the page to its longest line. */}
              <pre className="mt-2 max-h-48 overflow-auto rounded-2xl bg-muted/50 p-3 font-mono text-xs">
                {detail}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
