import type { DatabaseEngine } from "@noddle/shared/database-spec";

import {
  MariadbIcon,
  MongodbIcon,
  MysqlIcon,
  PostgresqlIcon,
  RedisIcon,
} from "@/components/features/database/database-icons";
import { cn } from "@/lib/utils";

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
