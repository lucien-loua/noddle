import { CaretDownIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { ResourcePanel } from "@/components/resource-panel";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { queries } from "@/lib/queries";

const WINDOW_LABEL: Record<1 | 6 | 24, string> = {
  1: "1h",
  6: "6h",
  24: "24h",
};

export function DatabaseResources({ databaseId }: { databaseId: string }) {
  const [windowHours, setWindowHours] = useState<1 | 6 | 24>(6);
  const windowLabel = useMemo(() => WINDOW_LABEL[windowHours], [windowHours]);

  const handleWindowHours1 = useCallback(() => setWindowHours(1), []);
  const handleWindowHours6 = useCallback(() => setWindowHours(6), []);
  const handleWindowHours24 = useCallback(() => setWindowHours(24), []);

  const metrics = useQuery({
    ...queries.databaseMetrics(databaseId, windowHours),
    refetchInterval: 30_000,
  });

  return (
    <ResourcePanel
      emptyNote={`No samples in the last ${windowHours} ${windowHours === 1 ? "hour" : "hours"}. Resources are sampled every minute on running databases.`}
      headerControls={
        <ButtonGroup>
          <ButtonGroupText>{windowLabel}</ButtonGroupText>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button className="ps-2!" size="sm" variant="outline">
                  <CaretDownIcon weight="regular" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onClick={handleWindowHours1}>
                Last hour
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleWindowHours6}>
                Last 6 hours
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleWindowHours24}>
                Last 24 hours
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      }
      series={metrics.data}
      unboundedNote="No memory limit declared — this database is bounded by the machine."
      windowHours={windowHours}
    />
  );
}
