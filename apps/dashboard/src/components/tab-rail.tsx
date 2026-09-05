import type { FocusEvent, ReactNode } from "react";
import { useCallback } from "react";

import { TabsList } from "@/components/ui/tabs";

export function TabRail({ children }: { children: ReactNode }) {
  const keepInView = useCallback((event: FocusEvent<HTMLDivElement>) => {
    event.target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  return (
    <div className="w-fit max-w-full shrink-0 rounded-full bg-muted p-1">
      <div className="scroll-fade-x no-scrollbar -m-1 scroll-px-10 overflow-x-auto overflow-y-hidden p-1">
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
