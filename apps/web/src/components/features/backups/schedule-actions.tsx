import { CaretDownIcon, PlusIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ScheduleActions({
  canRestore,
  createLabel,
  onCreate,
  onRestoreS3,
  restoreLabel,
}: {
  canRestore: boolean;
  createLabel: string;
  onCreate: () => void;
  onRestoreS3: () => void;
  restoreLabel: string;
}) {
  if (!canRestore) {
    return (
      <Button onClick={onCreate} size="sm" variant="outline">
        <PlusIcon data-icon="inline-start" weight="regular" />
        {createLabel}
      </Button>
    );
  }

  return (
    <ButtonGroup>
      <Button onClick={onCreate} size="sm" variant="outline">
        <PlusIcon data-icon="inline-start" weight="regular" />
        {createLabel}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button size="icon-sm" variant="outline">
              <CaretDownIcon weight="regular" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onRestoreS3}>
            {restoreLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
