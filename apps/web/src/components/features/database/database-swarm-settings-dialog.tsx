/**
 * biome-ignore-all lint/suspicious/noEqualsToNull: optional swarm fields are null|undefined
 * biome-ignore-all lint/performance/noJsxPropsBind: controlled dialog forms;
 * extracting every setState wrapper adds noise without shared children.
 */
import type { DatabaseSwarmSettings } from "@noddle/db/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  FocusModal,
  FocusModalContent,
  FocusModalDescription,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/format";
import { cn } from "@/lib/utils";
import { setDatabaseSwarmSettings } from "@/server/databases";

type MenuId =
  | "endpoint-spec"
  | "health-check"
  | "labels"
  | "mode"
  | "network"
  | "placement"
  | "restart-policy"
  | "rollback-config"
  | "stop-grace-period"
  | "update-config";

const MENU: { description: string; id: MenuId; label: string }[] = [
  {
    description: "Configure health check settings",
    id: "health-check",
    label: "Health Check",
  },
  {
    description: "Configure restart policy",
    id: "restart-policy",
    label: "Restart Policy",
  },
  {
    description: "Configure placement constraints",
    id: "placement",
    label: "Placement",
  },
  {
    description: "Configure update strategy",
    id: "update-config",
    label: "Update Config",
  },
  {
    description: "Configure rollback strategy",
    id: "rollback-config",
    label: "Rollback Config",
  },
  {
    description: "Configure service mode",
    id: "mode",
    label: "Mode",
  },
  {
    description: "Configure network attachments",
    id: "network",
    label: "Network",
  },
  {
    description: "Configure service labels",
    id: "labels",
    label: "Labels",
  },
  {
    description: "Configure stop grace period",
    id: "stop-grace-period",
    label: "Stop Grace Period",
  },
  {
    description: "Configure endpoint specification",
    id: "endpoint-spec",
    label: "Endpoint Spec",
  },
];

function parseOptionalInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function formatLabels(
  labels: Record<string, string> | null | undefined
): string {
  if (!labels) {
    return "";
  }
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export function DatabaseSwarmSettingsDialog({
  databaseId,
  onOpenChange,
  open,
  swarmSettings,
}: {
  databaseId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  swarmSettings: DatabaseSwarmSettings | null;
}) {
  const [section, setSection] = useState<MenuId>("health-check");
  const queryClient = useQueryClient();
  const router = useRouter();

  const save = useMutation({
    mutationFn: (slice: DatabaseSwarmSettings) =>
      setDatabaseSwarmSettings({
        data: { databaseId, swarmSettings: slice },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
    },
  });

  const clearSection = useCallback(async () => {
    const key = (
      {
        "endpoint-spec": "endpointSpec",
        "health-check": "healthCheck",
        labels: "labels",
        mode: "mode",
        network: "networks",
        placement: "placement",
        "restart-policy": "restartPolicy",
        "rollback-config": "rollbackConfig",
        "stop-grace-period": "stopGracePeriod",
        "update-config": "updateConfig",
      } as const
    )[section];
    await save.mutateAsync({ [key]: null });
  }, [save, section]);

  return (
    <FocusModal onOpenChange={onOpenChange} open={open}>
      <FocusModalContent>
        <FocusModalHeader>
          <div className="min-w-0">
            <FocusModalTitle>Swarm Settings</FocusModalTitle>
            <FocusModalDescription>
              Placement and network overrides can break logs, monitoring, and
              backups.
            </FocusModalDescription>
          </div>
        </FocusModalHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
          <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
            <nav className="scroll-fade-y no-scrollbar flex min-h-0 flex-col gap-1 overflow-y-auto">
              {MENU.map((item) => (
                <button
                  className={cn(
                    "rounded-lg px-3 py-2 text-left transition-colors",
                    section === item.id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                  key={item.id}
                  onClick={() => setSection(item.id)}
                  type="button"
                >
                  <div className="font-medium text-sm">{item.label}</div>
                  <div className="text-muted-foreground text-xs">
                    {item.description}
                  </div>
                </button>
              ))}
            </nav>
            <div className="min-h-0 min-w-0">
              <SectionForm
                isPending={save.isPending}
                onClear={clearSection}
                onError={save.error}
                onSave={(slice) => save.mutateAsync(slice)}
                section={section}
                swarmSettings={swarmSettings}
              />
            </div>
          </div>
        </div>
      </FocusModalContent>
    </FocusModal>
  );
}

interface SectionFormProps {
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: (slice: DatabaseSwarmSettings) => Promise<unknown>;
  section: MenuId;
  swarmSettings: DatabaseSwarmSettings | null;
}

/**
 * Which form each menu entry opens. A table, not a chain of ten `if`s: every
 * branch passed the same five props and differed only in the component and
 * the slice of settings it reads.
 */
const SECTION_FORMS: Record<
  MenuId,
  (props: SectionFormProps) => React.ReactNode
> = {
  "endpoint-spec": (p) => (
    <EndpointForm
      {...shared(p)}
      value={p.swarmSettings?.endpointSpec ?? null}
    />
  ),
  "health-check": (p) => (
    <HealthCheckForm
      {...shared(p)}
      value={p.swarmSettings?.healthCheck ?? null}
    />
  ),
  labels: (p) => (
    <LabelsForm {...shared(p)} value={p.swarmSettings?.labels ?? null} />
  ),
  mode: (p) => (
    <ModeForm {...shared(p)} value={p.swarmSettings?.mode ?? null} />
  ),
  network: (p) => (
    <NetworkForm {...shared(p)} value={p.swarmSettings?.networks ?? null} />
  ),
  placement: (p) => (
    <PlacementForm {...shared(p)} value={p.swarmSettings?.placement ?? null} />
  ),
  "restart-policy": (p) => (
    <RestartPolicyForm
      {...shared(p)}
      value={p.swarmSettings?.restartPolicy ?? null}
    />
  ),
  "rollback-config": (p) => (
    <UpdateConfigForm
      {...shared(p)}
      kind="rollback"
      value={p.swarmSettings?.rollbackConfig ?? null}
    />
  ),
  "stop-grace-period": (p) => (
    <StopGraceForm
      {...shared(p)}
      value={p.swarmSettings?.stopGracePeriod ?? null}
    />
  ),
  "update-config": (p) => (
    <UpdateConfigForm
      {...shared(p)}
      kind="update"
      value={p.swarmSettings?.updateConfig ?? null}
    />
  ),
};

/** The four props every section form takes, unchanged. */
function shared({ isPending, onClear, onError, onSave }: SectionFormProps) {
  return { isPending, onClear, onError, onSave };
}

function SectionForm(props: SectionFormProps) {
  return SECTION_FORMS[props.section](props);
}

function FormActions({
  isPending,
  onClear,
  onError,
  onSave,
  saveLabel,
}: {
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: () => Promise<void>;
  saveLabel: string;
}) {
  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-t bg-secondary/25 p-3"
      data-slot="swarm-section-footer"
    >
      {onError ? (
        <p className="text-destructive text-sm" role="alert">
          {errorMessage(onError, "could not save")}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button
          disabled={isPending}
          onClick={onClear}
          size="sm"
          type="button"
          variant="ghost"
        >
          Clear
        </Button>
        <Button disabled={isPending} onClick={onSave} size="sm" type="button">
          {isPending ? <Spinner data-icon="inline-start" /> : null}
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

function SectionShell({
  children,
  isPending,
  onClear,
  onError,
  onSave,
  saveLabel,
}: {
  children: ReactNode;
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: () => Promise<void>;
  saveLabel: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-background">
      <div className="scroll-fade-y no-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {children}
      </div>
      <FormActions
        isPending={isPending}
        onClear={onClear}
        onError={onError}
        onSave={onSave}
        saveLabel={saveLabel}
      />
    </div>
  );
}

function LabeledInput({
  description,
  label,
  onChange,
  placeholder,
  value,
}: {
  description?: string;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        value={value}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

function LabeledTextarea({
  description,
  label,
  onChange,
  placeholder,
  rows,
  value,
}: {
  description?: string;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  value: string;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        value={value}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

function LabeledSelect({
  children,
  label,
  onValueChange,
  placeholder,
  value,
}: {
  children: ReactNode;
  label: string;
  onValueChange: (value: string | null) => void;
  placeholder?: string;
  value: string | undefined;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select onValueChange={onValueChange} value={value}>
        <SelectTrigger className="w-full" id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>{children}</SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function NsField({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <LabeledInput
      description="Duration in nanoseconds."
      label={label}
      onChange={onChange}
      placeholder={placeholder}
      value={value}
    />
  );
}

function HealthCheckForm({
  isPending,
  onClear,
  onError,
  onSave,
  value,
}: {
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: (slice: DatabaseSwarmSettings) => Promise<unknown>;
  value: NonNullable<DatabaseSwarmSettings["healthCheck"]> | null;
}) {
  const [test, setTest] = useState(() => (value?.Test ?? []).join("\n"));
  const [interval, setIntervalNs] = useState(
    value?.Interval == null ? "" : String(value.Interval)
  );
  const [timeout, setTimeoutNs] = useState(
    value?.Timeout == null ? "" : String(value.Timeout)
  );
  const [retries, setRetries] = useState(
    value?.Retries == null ? "" : String(value.Retries)
  );
  const [startPeriod, setStartPeriod] = useState(
    value?.StartPeriod == null ? "" : String(value.StartPeriod)
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSave={async () => {
        await onSave({
          healthCheck: {
            Interval: parseOptionalInt(interval),
            Retries: parseOptionalInt(retries),
            StartPeriod: parseOptionalInt(startPeriod),
            Test: test
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
            Timeout: parseOptionalInt(timeout),
          },
        });
      }}
      saveLabel="Save Health Check"
    >
      <FieldGroup>
        <LabeledTextarea
          description="One argument per line."
          label="Test"
          onChange={setTest}
          placeholder={"CMD-SHELL\npg_isready -U postgres"}
          rows={4}
          value={test}
        />
        <NsField label="Interval" onChange={setIntervalNs} value={interval} />
        <NsField label="Timeout" onChange={setTimeoutNs} value={timeout} />
        <LabeledInput label="Retries" onChange={setRetries} value={retries} />
        <NsField
          label="Start period"
          onChange={setStartPeriod}
          value={startPeriod}
        />
      </FieldGroup>
    </SectionShell>
  );
}

function RestartPolicyForm({
  isPending,
  onClear,
  onError,
  onSave,
  value,
}: {
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: (slice: DatabaseSwarmSettings) => Promise<unknown>;
  value: NonNullable<DatabaseSwarmSettings["restartPolicy"]> | null;
}) {
  const [condition, setCondition] = useState<
    "" | "any" | "none" | "on-failure"
  >(value?.Condition ?? "");
  const [delay, setDelay] = useState(
    value?.Delay == null ? "" : String(value.Delay)
  );
  const [maxAttempts, setMaxAttempts] = useState(
    value?.MaxAttempts == null ? "" : String(value.MaxAttempts)
  );
  const [window, setWindow] = useState(
    value?.Window == null ? "" : String(value.Window)
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSave={async () => {
        await onSave({
          restartPolicy: {
            ...(condition ? { Condition: condition } : {}),
            Delay: parseOptionalInt(delay),
            MaxAttempts: parseOptionalInt(maxAttempts),
            Window: parseOptionalInt(window),
          },
        });
      }}
      saveLabel="Save Restart Policy"
    >
      <FieldGroup>
        <LabeledSelect
          label="Condition"
          onValueChange={(v) =>
            setCondition((v ?? "") as "" | "any" | "none" | "on-failure")
          }
          placeholder="Select restart condition"
          value={condition || undefined}
        >
          <SelectItem value="none">none</SelectItem>
          <SelectItem value="on-failure">on-failure</SelectItem>
          <SelectItem value="any">any</SelectItem>
        </LabeledSelect>
        <NsField label="Delay" onChange={setDelay} value={delay} />
        <LabeledInput
          label="Max Attempts"
          onChange={setMaxAttempts}
          value={maxAttempts}
        />
        <NsField label="Window" onChange={setWindow} value={window} />
      </FieldGroup>
    </SectionShell>
  );
}

function PlacementForm({
  isPending,
  onClear,
  onError,
  onSave,
  value,
}: {
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: (slice: DatabaseSwarmSettings) => Promise<unknown>;
  value: NonNullable<DatabaseSwarmSettings["placement"]> | null;
}) {
  const [constraints, setConstraints] = useState(() =>
    (value?.Constraints ?? []).join("\n")
  );
  const [maxReplicas, setMaxReplicas] = useState(
    value?.MaxReplicas == null ? "" : String(value.MaxReplicas)
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSave={async () => {
        const max = parseOptionalInt(maxReplicas);
        await onSave({
          placement: {
            Constraints: constraints
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
            ...(max === null || max === undefined ? {} : { MaxReplicas: max }),
          },
        });
      }}
      saveLabel="Save Placement"
    >
      <p className="mb-4 text-muted-foreground text-sm">
        Overriding placement can move the task off the node that holds the named
        volume. The database may start empty with no error.
      </p>
      <FieldGroup>
        <LabeledTextarea
          description="One constraint per line."
          label="Constraints"
          onChange={setConstraints}
          placeholder="node.id==…"
          rows={4}
          value={constraints}
        />
        <LabeledInput
          label="Max replicas per node"
          onChange={setMaxReplicas}
          value={maxReplicas}
        />
      </FieldGroup>
    </SectionShell>
  );
}

function UpdateConfigForm({
  isPending,
  kind,
  onClear,
  onError,
  onSave,
  value,
}: {
  isPending: boolean;
  kind: "rollback" | "update";
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: (slice: DatabaseSwarmSettings) => Promise<unknown>;
  value:
    | NonNullable<DatabaseSwarmSettings["rollbackConfig"]>
    | NonNullable<DatabaseSwarmSettings["updateConfig"]>
    | null;
}) {
  const [parallelism, setParallelism] = useState(
    value?.Parallelism == null ? "" : String(value.Parallelism)
  );
  const [delay, setDelay] = useState(
    value?.Delay == null ? "" : String(value.Delay)
  );
  const [failureAction, setFailureAction] = useState(
    value?.FailureAction ?? ""
  );
  const [monitor, setMonitor] = useState(
    value?.Monitor == null ? "" : String(value.Monitor)
  );
  const [order, setOrder] = useState(value?.Order ?? "");

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSave={async () => {
        const config = {
          Delay: parseOptionalInt(delay),
          ...(failureAction
            ? {
                FailureAction: failureAction as
                  | "continue"
                  | "pause"
                  | "rollback",
              }
            : {}),
          Monitor: parseOptionalInt(monitor),
          ...(order ? { Order: order as "start-first" | "stop-first" } : {}),
          Parallelism: parseOptionalInt(parallelism),
        };
        await onSave(
          kind === "update"
            ? { updateConfig: config }
            : {
                rollbackConfig: {
                  ...config,
                  FailureAction:
                    failureAction === "continue" || failureAction === "pause"
                      ? failureAction
                      : undefined,
                },
              }
        );
      }}
      saveLabel={
        kind === "update" ? "Save Update Config" : "Save Rollback Config"
      }
    >
      <FieldGroup>
        <LabeledInput
          label="Parallelism"
          onChange={setParallelism}
          value={parallelism}
        />
        <NsField label="Delay" onChange={setDelay} value={delay} />
        <LabeledSelect
          label="Failure action"
          onValueChange={(v) => setFailureAction(v ?? "")}
          placeholder="Select action"
          value={failureAction || undefined}
        >
          <SelectItem value="pause">pause</SelectItem>
          <SelectItem value="continue">continue</SelectItem>
          {kind === "update" ? (
            <SelectItem value="rollback">rollback</SelectItem>
          ) : null}
        </LabeledSelect>
        <NsField label="Monitor" onChange={setMonitor} value={monitor} />
        <LabeledSelect
          label="Order"
          onValueChange={(v) => setOrder(v ?? "")}
          placeholder="Select order"
          value={order || undefined}
        >
          <SelectItem value="stop-first">stop-first</SelectItem>
          <SelectItem value="start-first">start-first</SelectItem>
        </LabeledSelect>
      </FieldGroup>
    </SectionShell>
  );
}

function ModeForm({
  isPending,
  onClear,
  onError,
  onSave,
  value,
}: {
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: (slice: DatabaseSwarmSettings) => Promise<unknown>;
  value: NonNullable<DatabaseSwarmSettings["mode"]> | null;
}) {
  const initialKind = value?.Global ? "global" : "replicated";
  const [kind, setKind] = useState<"global" | "replicated">(initialKind);
  const [replicas, setReplicas] = useState(
    value?.Replicated?.Replicas == null
      ? "1"
      : String(value.Replicated.Replicas)
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSave={async () => {
        await onSave({
          mode:
            kind === "global"
              ? { Global: {} }
              : {
                  Replicated: {
                    Replicas: parseOptionalInt(replicas) ?? 1,
                  },
                },
        });
      }}
      saveLabel="Save Mode"
    >
      <FieldGroup>
        <LabeledSelect
          label="Mode"
          onValueChange={(v) => setKind(v as "global" | "replicated")}
          value={kind}
        >
          <SelectItem value="replicated">Replicated</SelectItem>
          <SelectItem value="global">Global</SelectItem>
        </LabeledSelect>
        {kind === "replicated" ? (
          <LabeledInput
            label="Replicas"
            onChange={setReplicas}
            value={replicas}
          />
        ) : null}
      </FieldGroup>
    </SectionShell>
  );
}

function NetworkForm({
  isPending,
  onClear,
  onError,
  onSave,
  value,
}: {
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: (slice: DatabaseSwarmSettings) => Promise<unknown>;
  value: NonNullable<DatabaseSwarmSettings["networks"]> | null;
}) {
  const initial = useMemo(
    () => (value ?? []).map((n) => n.Target).join("\n"),
    [value]
  );
  const [targets, setTargets] = useState(initial);

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSave={async () => {
        await onSave({
          networks: targets
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((Target) => ({ Target })),
        });
      }}
      saveLabel="Save Network"
    >
      <FieldGroup>
        <LabeledTextarea
          description="One network name per line."
          label="Network targets"
          onChange={setTargets}
          placeholder="noddle"
          rows={4}
          value={targets}
        />
      </FieldGroup>
    </SectionShell>
  );
}

function LabelsForm({
  isPending,
  onClear,
  onError,
  onSave,
  value,
}: {
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: (slice: DatabaseSwarmSettings) => Promise<unknown>;
  value: NonNullable<DatabaseSwarmSettings["labels"]> | null;
}) {
  const [raw, setRaw] = useState(() => formatLabels(value));

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSave={async () => {
        await onSave({ labels: parseLabels(raw) });
      }}
      saveLabel="Save Labels"
    >
      <FieldGroup>
        <LabeledTextarea
          description="key=value, one per line."
          label="Labels"
          onChange={setRaw}
          rows={6}
          value={raw}
        />
      </FieldGroup>
    </SectionShell>
  );
}

function StopGraceForm({
  isPending,
  onClear,
  onError,
  onSave,
  value,
}: {
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: (slice: DatabaseSwarmSettings) => Promise<unknown>;
  value: number | null;
}) {
  const [raw, setRaw] = useState(
    value === null || value === undefined ? "" : String(value)
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSave={async () => {
        await onSave({ stopGracePeriod: parseOptionalInt(raw) });
      }}
      saveLabel="Save Stop Grace Period"
    >
      <FieldGroup>
        <NsField label="Stop grace period" onChange={setRaw} value={raw} />
      </FieldGroup>
    </SectionShell>
  );
}

function EndpointForm({
  isPending,
  onClear,
  onError,
  onSave,
  value,
}: {
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSave: (slice: DatabaseSwarmSettings) => Promise<unknown>;
  value: NonNullable<DatabaseSwarmSettings["endpointSpec"]> | null;
}) {
  const [mode, setMode] = useState(value?.Mode ?? "");

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSave={async () => {
        await onSave({
          endpointSpec: mode ? { Mode: mode as "dnsrr" | "vip" } : {},
        });
      }}
      saveLabel="Save Endpoint Spec"
    >
      <FieldGroup>
        <LabeledSelect
          label="Mode"
          onValueChange={(v) => setMode(v ?? "")}
          placeholder="Select endpoint mode"
          value={mode || undefined}
        >
          <SelectItem value="vip">vip</SelectItem>
          <SelectItem value="dnsrr">dnsrr</SelectItem>
        </LabeledSelect>
      </FieldGroup>
    </SectionShell>
  );
}
