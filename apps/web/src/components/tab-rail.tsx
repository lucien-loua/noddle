import type { FocusEvent, ReactNode } from "react";
import { useCallback } from "react";
import { TabsList } from "@/components/ui/tabs";

export function TabRail({ children }: { children: ReactNode }) {
  // Base UI moves keyboard focus with `preventScroll`, so the rail
  // wasn't following: the arrow key would land on the last tab 23px
  // outside the edge.
  const keepInView = useCallback((event: FocusEvent<HTMLDivElement>) => {
    event.target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  return (
    <div className="w-fit max-w-full shrink-0 rounded-full bg-muted p-1">
      {/* `overflow-y-hidden` isn't redundant: an axis set to `auto` forces
          the other from `visible` to `auto`. `-m-1 p-1` gives back the
          4px the focus ring overflows by, `scroll-px-10` the width of the
          fade. */}
      <div className="scroll-fade-x no-scrollbar -m-1 scroll-px-10 overflow-x-auto overflow-y-hidden p-1">
        {/* Height overridden WITH its prefix: `tabsListVariants` sets it
            as `group-data-horizontal/tabs:h-9`, which a bare `h-7`
            doesn't beat. */}
        <TabsList
          className="bg-transparent p-0 group-data-horizontal/tabs:h-7"
          onFocus={keepInView}
        >
          {children}
        </TabsList>
      </div>
    </div>
  );
}
