import { TerminalLogs } from "@/components/terminal-logs";
import type { TerminalLogLine } from "@/components/terminal-logs";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import {
  FocusModal,
  FocusModalBody,
  FocusModalContent,
  FocusModalDescription,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import { Status, StatusIndicator, StatusLabel } from "@/components/ui/status";
import { backupKindLabel, backupLabel, byteSize, duration } from "@/lib/format";

import type { BackupRunRow } from "./run-types";

export function BackupRunDetailDialog<T extends BackupRunRow>({
  backup,
  logLines,
  onOpenChange,
  open,
  title,
}: {
  backup: T | null;
  logLines: (backup: T) => TerminalLogLine[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  const lines = backup ? logLines(backup) : [];
  const status = backup ? backupLabel(backup.status) : null;
  const runMeta = backup
    ? [
        backupKindLabel(backup.kind),
        backup.status === "completed" ? byteSize(backup.sizeBytes) : null,
        duration(backup.createdAt, backup.finishedAt),
      ]
        .filter((part): part is string => Boolean(part) && part !== "—")
        .join(" · ")
    : "";

  return (
    <FocusModal onOpenChange={onOpenChange} open={open && backup !== null}>
      <FocusModalContent>
        {backup && status ? (
          <TerminalLogs lines={lines}>
            <FocusModalHeader>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <FocusModalTitle>{title}</FocusModalTitle>
                  {runMeta ? (
                    <FocusModalDescription>{runMeta}</FocusModalDescription>
                  ) : null}
                </div>
                <Status tone={status.tone}>
                  <StatusIndicator />
                  <StatusLabel>{status.label}</StatusLabel>
                </Status>
                <ButtonGroup>
                  <ButtonGroupText>
                    {lines.length === 1 ? "1 line" : `${lines.length} lines`}
                  </ButtonGroupText>
                  <TerminalLogs.Copy label="logs" />
                </ButtonGroup>
              </div>
            </FocusModalHeader>
            <FocusModalBody className="flex min-h-0 flex-col overflow-hidden p-0">
              <div className="scroll-fade no-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
                {lines.length === 0 ? (
                  <span className="text-muted-foreground text-sm">
                    No logs for this run.
                  </span>
                ) : (
                  lines.map((line) => (
                    <TerminalLogs.Line key={line.id} line={line} />
                  ))
                )}
              </div>
            </FocusModalBody>
          </TerminalLogs>
        ) : null}
      </FocusModalContent>
    </FocusModal>
  );
}
