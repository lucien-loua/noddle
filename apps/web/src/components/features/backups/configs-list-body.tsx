import type { Icon } from "@phosphor-icons/react";
import { ArchiveIcon } from "@phosphor-icons/react";

import { IconStack } from "@/components/icon-stack";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";

export function ConfigsListBody({
  canCreate,
  canRestore,
  configsLoading,
  createLabel,
  emptyDescription,
  emptyIcon: EmptyIcon,
  emptyTitle,
  onCreate,
  onRestoreS3,
  restoreLabel,
  rowCount,
}: {
  canCreate: boolean;
  canRestore: boolean;
  configsLoading: boolean;
  createLabel: string;
  emptyDescription: string;
  emptyIcon: Icon;
  emptyTitle: string;
  onCreate: () => void;
  onRestoreS3: () => void;
  restoreLabel: string;
  rowCount: number;
}) {
  if (configsLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }

  if (rowCount === 0) {
    return (
      <Empty className="min-h-0 flex-1 border-0">
        <EmptyHeader>
          <EmptyMedia>
            <IconStack>
              <EmptyIcon className="size-5" />
            </IconStack>
          </EmptyMedia>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
        {canCreate ? (
          <EmptyContent className="flex flex-row flex-wrap justify-center gap-2">
            <Button onClick={onCreate}>
              <EmptyIcon data-icon="inline-start" weight="regular" />
              {createLabel}
            </Button>
            {canRestore ? (
              <Button onClick={onRestoreS3} variant="outline">
                <ArchiveIcon data-icon="inline-start" weight="regular" />
                {restoreLabel}
              </Button>
            ) : null}
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }

  return null;
}
