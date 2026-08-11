import type { DatabaseEngine } from "@noddle/shared/database-engines";
import {
  MariadbIcon,
  MongodbIcon,
  MysqlIcon,
  PostgresqlIcon,
  RedisIcon,
} from "@/components/features/database/database-icons";
import { cn } from "@/lib/utils";

/**
 * A brand's color class, for when its original color doesn't survive the
 * theme.
 *
 * MariaDB is the only case: its SVG has only ONE fill, `#231F20`, a
 * near-black — so it's invisible on a dark background. Its path was
 * switched to `currentColor` and follows `--foreground`, which is also what
 * MariaDB does with its own brand: black on light, white on dark.
 *
 * The other four keep their colors as-is; they all carry a vivid hue (blue,
 * green, red) that holds up on both backgrounds. Verified, not assumed.
 */
const ENGINE_TINT: Partial<Record<DatabaseEngine, string>> = {
  mariadb: "text-foreground",
};

const ENGINE_ICON: Record<
  DatabaseEngine,
  (props: { className?: string }) => React.JSX.Element
> = {
  mariadb: MariadbIcon,
  mongo: MongodbIcon,
  mysql: MysqlIcon,
  postgres: PostgresqlIcon,
  redis: RedisIcon,
};

/** Sizes, plain: the brand mark is NOT inside an `IconTile`. A brand logo
 *  already carries its own shape and colors; enclosing it in a pill added a
 *  frame that contributes nothing and shrank it. */
const SIZE_CLASS = {
  default: "size-8",
  lg: "size-10",
  sm: "size-6",
  xs: "size-5",
} as const;

export function DatabaseMark({
  className,
  engine,
  size = "xs",
}: {
  className?: string;
  engine: DatabaseEngine;
  size?: "default" | "lg" | "sm" | "xs";
}) {
  const Icon = ENGINE_ICON[engine];
  // `aria-hidden`: the engine's name is ALWAYS written next to it by the
  // caller, so announcing it a second time would say nothing more.
  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0",
        SIZE_CLASS[size],
        ENGINE_TINT[engine],
        className
      )}
    >
      <Icon className="size-full" />
    </span>
  );
}
