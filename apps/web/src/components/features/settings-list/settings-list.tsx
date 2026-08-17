import { createContext, use, useMemo } from "react";
import type { ReactNode } from "react";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { cn } from "@/lib/utils";

interface SettingsListContextValue {
  isEmpty: boolean;
}

const SettingsListContext = createContext<SettingsListContextValue | null>(
  null
);

function useSettingsList(): SettingsListContextValue {
  const value = use(SettingsListContext);
  if (!value) {
    throw new Error("SettingsList.* must be used within <SettingsList>");
  }
  return value;
}

function SettingsListRoot({
  children,
  isEmpty,
}: {
  children: ReactNode;
  isEmpty: boolean;
}) {
  const value = useMemo(() => ({ isEmpty }), [isEmpty]);
  return <SettingsListContext value={value}>{children}</SettingsListContext>;
}

function SettingsListEmpty({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { isEmpty } = useSettingsList();
  if (!isEmpty) {
    return null;
  }
  return <Empty className={cn("h-full", className)}>{children}</Empty>;
}

function SettingsListBody({ children }: { children: ReactNode }) {
  const { isEmpty } = useSettingsList();
  if (isEmpty) {
    return null;
  }
  return children;
}

function SettingsListFrame({
  children,
  description,
  /**
   * `false` when the children are ALREADY panels — a list of ResourceCards,
   * for instance. Wrapping a panel in a panel draws its border twice, which
   * is what the servers list showed.
   */
  panel = true,
  panelClassName,
  title,
}: {
  children: ReactNode;
  description: ReactNode;
  panel?: boolean;
  panelClassName?: string;
  title: ReactNode;
}) {
  const { isEmpty } = useSettingsList();
  if (isEmpty) {
    return null;
  }
  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>{title}</FrameTitle>
        <FrameDescription>{description}</FrameDescription>
      </FrameHeader>
      {panel ? (
        <FramePanel className={cn("p-0", panelClassName)}>
          {children}
        </FramePanel>
      ) : (
        children
      )}
    </Frame>
  );
}

export const SettingsList = Object.assign(SettingsListRoot, {
  Body: SettingsListBody,
  Empty: SettingsListEmpty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Frame: SettingsListFrame,
});
