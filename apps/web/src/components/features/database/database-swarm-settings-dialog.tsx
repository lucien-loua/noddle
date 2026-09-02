import type { DatabaseSwarmSettings } from "@noddle/db/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import type { FieldSelectOption } from "@/components/fields/field-select";
import { useAppForm } from "@/components/fields/lib/form";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import {
  FocusModal,
  FocusModalContent,
  FocusModalDescription,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import { Spinner } from "@/components/ui/spinner";
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
    description: "How Swarm decides the container is alive",
    id: "health-check",
    label: "Health check",
  },
  {
    description: "When a stopped container is started again",
    id: "restart-policy",
    label: "Restart policy",
  },
  {
    description: "Which nodes this database may run on",
    id: "placement",
    label: "Placement",
  },
  {
    description: "How a new version replaces the running one",
    id: "update-config",
    label: "Update config",
  },
  {
    description: "How Swarm returns to the previous version",
    id: "rollback-config",
    label: "Rollback config",
  },
  {
    description: "Replicated with a replica count, or global",
    id: "mode",
    label: "Mode",
  },
  {
    description: "Overlay networks the container joins",
    id: "network",
    label: "Network",
  },
  {
    description: "Key/value pairs attached to the Swarm service",
    id: "labels",
    label: "Labels",
  },
  {
    description: "How long a container may take to shut down",
    id: "stop-grace-period",
    label: "Stop grace period",
  },
  {
    description: "How the port is published outside the overlay",
    id: "endpoint-spec",
    label: "Endpoint spec",
  },
];

const optionalIntSchema = z
  .number({ error: "Enter a number." })
  .int("Enter a whole number.")
  .nullable();

const NS_DESCRIPTION = "Duration in nanoseconds.";

const RESTART_CONDITIONS: FieldSelectOption[] = [
  { label: "none", value: "none" },
  { label: "on-failure", value: "on-failure" },
  { label: "any", value: "any" },
];

const UPDATE_ORDERS: FieldSelectOption[] = [
  { label: "stop-first", value: "stop-first" },
  { label: "start-first", value: "start-first" },
];

const MODE_OPTIONS: FieldSelectOption[] = [
  { label: "Replicated", value: "replicated" },
  { label: "Global", value: "global" },
];

const ENDPOINT_MODES: FieldSelectOption[] = [
  { label: "vip", value: "vip" },
  { label: "dnsrr", value: "dnsrr" },
];

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
  saveLabel,
}: {
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
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
        <Button disabled={isPending} size="sm" type="submit">
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
  onSubmit,
  saveLabel,
}: {
  children: React.ReactNode;
  isPending: boolean;
  onClear: () => Promise<void>;
  onError: Error | null;
  onSubmit: (event: SubmitEvent) => void;
  saveLabel: string;
}) {
  return (
    <form
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-background"
      onSubmit={onSubmit}
    >
      <div className="scroll-fade-y no-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {children}
      </div>
      <FormActions
        isPending={isPending}
        onClear={onClear}
        onError={onError}
        saveLabel={saveLabel}
      />
    </form>
  );
}

interface HealthCheckFormValues {
  interval: number | null;
  retries: number | null;
  startPeriod: number | null;
  test: string;
  timeout: number | null;
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
  const form = useAppForm({
    defaultValues: {
      interval: value?.Interval ?? null,
      retries: value?.Retries ?? null,
      startPeriod: value?.StartPeriod ?? null,
      test: (value?.Test ?? []).join("\n"),
      timeout: value?.Timeout ?? null,
    } satisfies HealthCheckFormValues,
    onSubmit: ({ value: v }) =>
      onSave({
        healthCheck: {
          Interval: v.interval,
          Retries: v.retries,
          StartPeriod: v.startPeriod,
          Test: v.test
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
          Timeout: v.timeout,
        },
      }),
    validators: {
      onDynamic: z.object({
        interval: optionalIntSchema,
        retries: optionalIntSchema,
        startPeriod: optionalIntSchema,
        test: z.string(),
        timeout: optionalIntSchema,
      }),
    },
  });

  useEffect(() => {
    form.reset();
  }, [form.reset, value]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSubmit={handleSubmit}
      saveLabel="Save health check"
    >
      <FieldGroup>
        <form.AppField name="test">
          {(f) => (
            <f.FieldTextarea
              description="One argument per line."
              label="Test"
              placeholder={"CMD-SHELL\npg_isready -U postgres"}
              rows={4}
            />
          )}
        </form.AppField>
        <form.AppField name="interval">
          {(f) => (
            <f.FieldNumber description={NS_DESCRIPTION} label="Interval" />
          )}
        </form.AppField>
        <form.AppField name="timeout">
          {(f) => (
            <f.FieldNumber description={NS_DESCRIPTION} label="Timeout" />
          )}
        </form.AppField>
        <form.AppField name="retries">
          {(f) => <f.FieldNumber label="Retries" />}
        </form.AppField>
        <form.AppField name="startPeriod">
          {(f) => (
            <f.FieldNumber description={NS_DESCRIPTION} label="Start period" />
          )}
        </form.AppField>
      </FieldGroup>
    </SectionShell>
  );
}

interface RestartPolicyFormValues {
  condition: "" | "any" | "none" | "on-failure";
  delay: number | null;
  maxAttempts: number | null;
  window: number | null;
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
  const form = useAppForm({
    defaultValues: {
      condition: value?.Condition ?? "",
      delay: value?.Delay ?? null,
      maxAttempts: value?.MaxAttempts ?? null,
      window: value?.Window ?? null,
    } satisfies RestartPolicyFormValues,
    onSubmit: ({ value: v }) =>
      onSave({
        restartPolicy: {
          ...(v.condition ? { Condition: v.condition } : {}),
          Delay: v.delay,
          MaxAttempts: v.maxAttempts,
          Window: v.window,
        },
      }),
    validators: {
      onDynamic: z.object({
        condition: z.enum(
          ["", "any", "none", "on-failure"],
          "Choose a restart condition."
        ),
        delay: optionalIntSchema,
        maxAttempts: optionalIntSchema,
        window: optionalIntSchema,
      }),
    },
  });

  useEffect(() => {
    form.reset();
  }, [form.reset, value]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSubmit={handleSubmit}
      saveLabel="Save restart policy"
    >
      <FieldGroup>
        <form.AppField name="condition">
          {(f) => (
            <f.FieldSelect
              label="Condition"
              options={RESTART_CONDITIONS}
              placeholder="Select restart condition"
            />
          )}
        </form.AppField>
        <form.AppField name="delay">
          {(f) => <f.FieldNumber description={NS_DESCRIPTION} label="Delay" />}
        </form.AppField>
        <form.AppField name="maxAttempts">
          {(f) => <f.FieldNumber label="Max attempts" />}
        </form.AppField>
        <form.AppField name="window">
          {(f) => <f.FieldNumber description={NS_DESCRIPTION} label="Window" />}
        </form.AppField>
      </FieldGroup>
    </SectionShell>
  );
}

interface PlacementFormValues {
  constraints: string;
  maxReplicas: number | null;
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
  const form = useAppForm({
    defaultValues: {
      constraints: (value?.Constraints ?? []).join("\n"),
      maxReplicas: value?.MaxReplicas ?? null,
    } satisfies PlacementFormValues,
    onSubmit: ({ value: v }) =>
      onSave({
        placement: {
          Constraints: v.constraints
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
          ...(v.maxReplicas === null ? {} : { MaxReplicas: v.maxReplicas }),
        },
      }),
    validators: {
      onDynamic: z.object({
        constraints: z.string(),
        maxReplicas: optionalIntSchema,
      }),
    },
  });

  useEffect(() => {
    form.reset();
  }, [form.reset, value]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSubmit={handleSubmit}
      saveLabel="Save Placement"
    >
      <p className="mb-4 text-muted-foreground text-sm">
        Overriding placement can move the task off the node that holds the named
        volume. The database may start empty with no error.
      </p>
      <FieldGroup>
        <form.AppField name="constraints">
          {(f) => (
            <f.FieldTextarea
              description="One constraint per line."
              label="Constraints"
              placeholder="node.id==…"
              rows={4}
            />
          )}
        </form.AppField>
        <form.AppField name="maxReplicas">
          {(f) => <f.FieldNumber label="Max replicas per node" />}
        </form.AppField>
      </FieldGroup>
    </SectionShell>
  );
}

interface UpdateConfigFormValues {
  delay: number | null;
  failureAction: "" | "continue" | "pause" | "rollback";
  monitor: number | null;
  order: "" | "start-first" | "stop-first";
  parallelism: number | null;
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
  const failureActions: FieldSelectOption[] =
    kind === "update"
      ? [
          { label: "pause", value: "pause" },
          { label: "continue", value: "continue" },
          { label: "rollback", value: "rollback" },
        ]
      : [
          { label: "pause", value: "pause" },
          { label: "continue", value: "continue" },
        ];

  const form = useAppForm({
    defaultValues: {
      delay: value?.Delay ?? null,
      failureAction: value?.FailureAction ?? "",
      monitor: value?.Monitor ?? null,
      order: value?.Order ?? "",
      parallelism: value?.Parallelism ?? null,
    } satisfies UpdateConfigFormValues,
    onSubmit: ({ value: v }) => {
      const config = {
        Delay: v.delay,
        ...(v.failureAction ? { FailureAction: v.failureAction } : {}),
        Monitor: v.monitor,
        ...(v.order ? { Order: v.order } : {}),
        Parallelism: v.parallelism,
      };
      return onSave(
        kind === "update"
          ? { updateConfig: config }
          : {
              rollbackConfig: {
                ...config,
                FailureAction:
                  v.failureAction === "continue" || v.failureAction === "pause"
                    ? v.failureAction
                    : undefined,
              },
            }
      );
    },
    validators: {
      onDynamic: z.object({
        delay: optionalIntSchema,
        failureAction: z.enum(
          ["", "continue", "pause", "rollback"],
          "Choose a failure action."
        ),
        monitor: optionalIntSchema,
        order: z.enum(
          ["", "start-first", "stop-first"],
          "Choose an update order."
        ),
        parallelism: optionalIntSchema,
      }),
    },
  });

  useEffect(() => {
    form.reset();
  }, [form.reset, value]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSubmit={handleSubmit}
      saveLabel={
        kind === "update" ? "Save update config" : "Save rollback config"
      }
    >
      <FieldGroup>
        <form.AppField name="parallelism">
          {(f) => <f.FieldNumber label="Parallelism" />}
        </form.AppField>
        <form.AppField name="delay">
          {(f) => <f.FieldNumber description={NS_DESCRIPTION} label="Delay" />}
        </form.AppField>
        <form.AppField name="failureAction">
          {(f) => (
            <f.FieldSelect
              label="Failure action"
              options={failureActions}
              placeholder="Select action"
            />
          )}
        </form.AppField>
        <form.AppField name="monitor">
          {(f) => (
            <f.FieldNumber description={NS_DESCRIPTION} label="Monitor" />
          )}
        </form.AppField>
        <form.AppField name="order">
          {(f) => (
            <f.FieldSelect
              label="Order"
              options={UPDATE_ORDERS}
              placeholder="Select order"
            />
          )}
        </form.AppField>
      </FieldGroup>
    </SectionShell>
  );
}

interface ModeFormValues {
  kind: "global" | "replicated";
  replicas: number | null;
}

function selectModeKind(state: { values: ModeFormValues }) {
  return state.values.kind;
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
  const defaultValues: ModeFormValues = {
    kind: value?.Global ? "global" : "replicated",
    replicas: value?.Replicated?.Replicas ?? 1,
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value: v }) =>
      onSave({
        mode:
          v.kind === "global"
            ? { Global: {} }
            : { Replicated: { Replicas: v.replicas ?? 1 } },
      }),
    validators: {
      onDynamic: z.object({
        kind: z.enum(["global", "replicated"], "Choose a service mode."),
        replicas: z
          .number({ error: "Enter a replica count." })
          .int("Enter a whole number.")
          .min(1, "Run at least 1 replica.")
          .nullable(),
      }),
    },
  });

  useEffect(() => {
    form.reset();
  }, [form.reset, value]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSubmit={handleSubmit}
      saveLabel="Save mode"
    >
      <FieldGroup>
        <form.AppField name="kind">
          {(f) => <f.FieldSelect label="Mode" options={MODE_OPTIONS} />}
        </form.AppField>
        <form.Subscribe selector={selectModeKind}>
          {(kind) =>
            kind === "replicated" ? (
              <form.AppField name="replicas">
                {(f) => <f.FieldNumber label="Replicas" min={1} />}
              </form.AppField>
            ) : null
          }
        </form.Subscribe>
      </FieldGroup>
    </SectionShell>
  );
}

interface NetworkFormValues {
  targets: string;
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
  const form = useAppForm({
    defaultValues: {
      targets: (value ?? []).map((n) => n.Target).join("\n"),
    } satisfies NetworkFormValues,
    onSubmit: ({ value: v }) =>
      onSave({
        networks: v.targets
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((Target) => ({ Target })),
      }),
    validators: {
      onDynamic: z.object({ targets: z.string() }),
    },
  });

  useEffect(() => {
    form.reset();
  }, [form.reset, value]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSubmit={handleSubmit}
      saveLabel="Save network"
    >
      <FieldGroup>
        <form.AppField name="targets">
          {(f) => (
            <f.FieldTextarea
              description="One network name per line."
              label="Network targets"
              placeholder="noddle"
              rows={4}
            />
          )}
        </form.AppField>
      </FieldGroup>
    </SectionShell>
  );
}

interface LabelsFormValues {
  raw: string;
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
  const form = useAppForm({
    defaultValues: { raw: formatLabels(value) } satisfies LabelsFormValues,
    onSubmit: ({ value: v }) => onSave({ labels: parseLabels(v.raw) }),
    validators: {
      onDynamic: z.object({ raw: z.string() }),
    },
  });

  useEffect(() => {
    form.reset();
  }, [form.reset, value]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSubmit={handleSubmit}
      saveLabel="Save labels"
    >
      <FieldGroup>
        <form.AppField name="raw">
          {(f) => (
            <f.FieldTextarea
              description="key=value, one per line."
              label="Labels"
              rows={6}
            />
          )}
        </form.AppField>
      </FieldGroup>
    </SectionShell>
  );
}

interface StopGraceFormValues {
  stopGracePeriod: number | null;
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
  const form = useAppForm({
    defaultValues: {
      stopGracePeriod: value ?? null,
    } satisfies StopGraceFormValues,
    onSubmit: ({ value: v }) => onSave({ stopGracePeriod: v.stopGracePeriod }),
    validators: {
      onDynamic: z.object({
        stopGracePeriod: optionalIntSchema,
      }),
    },
  });

  useEffect(() => {
    form.reset();
  }, [form.reset, value]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSubmit={handleSubmit}
      saveLabel="Save stop grace period"
    >
      <FieldGroup>
        <form.AppField name="stopGracePeriod">
          {(f) => (
            <f.FieldNumber
              description={NS_DESCRIPTION}
              label="Stop grace period"
            />
          )}
        </form.AppField>
      </FieldGroup>
    </SectionShell>
  );
}

interface EndpointFormValues {
  mode: "" | "dnsrr" | "vip";
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
  const form = useAppForm({
    defaultValues: { mode: value?.Mode ?? "" } satisfies EndpointFormValues,
    onSubmit: ({ value: v }) =>
      onSave({ endpointSpec: v.mode ? { Mode: v.mode } : {} }),
    validators: {
      onDynamic: z.object({
        mode: z.enum(["", "dnsrr", "vip"], "Choose an endpoint mode."),
      }),
    },
  });

  useEffect(() => {
    form.reset();
  }, [form.reset, value]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <SectionShell
      isPending={isPending}
      onClear={onClear}
      onError={onError}
      onSubmit={handleSubmit}
      saveLabel="Save endpoint spec"
    >
      <FieldGroup>
        <form.AppField name="mode">
          {(f) => (
            <f.FieldSelect
              label="Mode"
              options={ENDPOINT_MODES}
              placeholder="Select endpoint mode"
            />
          )}
        </form.AppField>
      </FieldGroup>
    </SectionShell>
  );
}
