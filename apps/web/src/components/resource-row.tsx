import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { badgeVariant, dotClass } from "@/lib/format";
import type { Tone } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  /** Right-side action: Deploy, Attach… Always visible, never in a menu. */
  action?: ReactNode;
  /** The engine's mark, for a database. Absent for the rest. */
  mark?: ReactNode;
  /** What distinguishes this row from others in the same group. Hidden below `md`. */
  meta?: string | null;
  name: string;
  /** Opens the detail view. Absent = row cannot be expanded (a server). */
  onToggle?: () => void;
  secondary?: ReactNode;
  selected?: boolean;
  /** Discreet note next to the name ("being watched"). */
  tag?: ReactNode;
  tone: Tone;
  toneLabel: string;
}

export function ResourceRow({
  action,
  mark,
  meta,
  name,
  onToggle,
  secondary,
  selected,
  tag,
  tone,
  toneLabel,
}: Props) {
  const title = (
    <ItemTitle>
      {/* The mark goes INSIDE the title, not in `ItemMedia`: the latter
          already carries the status dot, and two symbols side by side on
          the left would make it unclear which one answers "is it
          running". */}
      {mark}
      {name}
      {tag}
    </ItemTitle>
  );
  const description = secondary ? <ItemDescription>{secondary}</ItemDescription> : null;

  return (
    <Item
      className={cn("relative", onToggle && "hover:bg-muted", selected && "bg-muted/40")}
      size="sm"
      variant="outline"
    >
      {/* `role="img"`: a bare span carries no aria-label, and this dot is
          the answer to "is it running?" for someone who can't distinguish
          colors. */}
      <ItemMedia>
        <span
          aria-label={toneLabel}
          className={cn("mt-1 size-2 shrink-0 rounded-full", dotClass(tone))}
          role="img"
        />
      </ItemMedia>

      <ItemContent className="min-w-0">
        {onToggle ? (
          // `after:inset-0` extends the target to the ENTIRE row without
          // nesting a button inside a clickable block: the semantics
          // remain those of a single button, and the actions on the right
          // pass above it by being positioned.
          <button
            className="min-w-0 text-start after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
            onClick={onToggle}
            type="button"
          >
            {title}
            {description}
          </button>
        ) : (
          <>
            {title}
            {description}
          </>
        )}
      </ItemContent>

      {/* The metadata yields its place before the status and the action:
          on a phone, "which commit" matters less than "is it running" and
          "redeploy".

          `suppressHydrationWarning`: it contains a RELATIVE time, computed
          at render. The server writes "49 min ago", the client rehydrates
          a second later and computes "50 min ago". React saw a divergence
          there and discarded the whole tree to rebuild it — on every
          dashboard load. This is the escape hatch intended for a
          timestamp, not a patch over a real mismatch. */}
      <ItemActions className="relative">
        {meta ? (
          <span
            className="hidden whitespace-nowrap text-muted-foreground text-xs md:inline"
            suppressHydrationWarning
          >
            {meta}
          </span>
        ) : null}
        <Badge variant={badgeVariant(tone)}>{toneLabel}</Badge>
        {action}
      </ItemActions>
    </Item>
  );
}

export function RowGroup({
  children,
  id,
  title,
}: {
  children: ReactNode;
  id?: string;
  title?: ReactNode;
}) {
  return (
    <section className="min-w-0" id={id}>
      {title ? (
        <h3 className="mb-2 px-1 font-medium text-muted-foreground text-xs">{title}</h3>
      ) : null}
      <ItemGroup>{children}</ItemGroup>
    </section>
  );
}
