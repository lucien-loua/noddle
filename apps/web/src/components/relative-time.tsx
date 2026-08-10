import { relativeTime } from "@/lib/format";

/**
 * The exact time, for the tooltip.
 *
 * "3 days ago" answers "is this recent?" and that's the common question;
 * "August 1 at 2:32 PM" answers "was this before the incident?", which is
 * the question we ask when it matters. Both fit without cluttering, one on
 * hover over the other.
 */
function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export function RelativeTime({ iso }: { iso: string }) {
  return (
    // `<time>` rather than a `<span>`: the machine-readable value remains
    // available in `dateTime` even when the displayed text is approximate.
    <time dateTime={iso} suppressHydrationWarning title={absoluteTime(iso)}>
      {relativeTime(iso)}
    </time>
  );
}
