import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";

/**
 * The headline of a failure, and its tool output only if asked for.
 *
 * Two things keep this from widening the page, and both are needed. The
 * wrapper carries `min-w-0`, because a flex child defaults to
 * `min-width: auto` and a long line pushes the CONTAINER wider instead of
 * scrolling inside it. The `pre` then scrolls on its own axis.
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
    <Frame className="mb-3 min-w-0" variant="ghost">
      <Collapsible className="min-w-0" onOpenChange={setOpen} open={open}>
        {/* Same shape as the other frames with an action: the trigger is
            the header's action, not a control floating under it. */}
        <FrameHeader className="flex-row justify-between gap-3">
          <div className="min-w-0">
            <FrameTitle className="wrap-anywhere text-destructive">
              {headline}
            </FrameTitle>
            {detail ? (
              <FrameDescription>
                The full output is in this deployment&apos;s build logs.
              </FrameDescription>
            ) : null}
          </div>
          {detail ? (
            <CollapsibleTrigger
              render={
                <Button size="sm" variant="outline">
                  {open ? "Hide details" : "Show details"}
                </Button>
              }
            />
          ) : null}
        </FrameHeader>

        {detail ? (
          <CollapsibleContent className="min-w-0">
            <FramePanel className="min-w-0 p-0">
              <pre className="no-scrollbar scroll-fade-x max-h-56 overflow-auto p-3 font-mono text-muted-foreground text-xs leading-relaxed">
                {detail}
              </pre>
            </FramePanel>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </Frame>
  );
}
