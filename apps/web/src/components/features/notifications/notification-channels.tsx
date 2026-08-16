import { notificationChannelSchema } from "@noddle/shared/validation/notification";
import { BellIcon, LinkIcon, TagIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import type { SubmitEvent } from "react";
import { useCallback, useEffect } from "react";
import type { z } from "zod";

import { useResourceList } from "@/components/features/settings-list/hooks/use-resource-list";
import { SettingsList } from "@/components/features/settings-list/settings-list";
import { useAppForm } from "@/components/fields/lib/form";
import { IconStack } from "@/components/icon-stack";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import {
  addChannel,
  deleteChannel,
  testChannel,
  updateChannel,
} from "@/server/notifications";
import type { ChannelRow } from "@/server/notifications";

const KINDS: { label: string; value: ChannelRow["kind"] }[] = [
  { label: "Discord", value: "discord" },
  { label: "Slack", value: "slack" },
  { label: "Webhook", value: "webhook" },
];

const KIND_LABEL: Record<ChannelRow["kind"], string> = {
  discord: "Discord",
  slack: "Slack",
  webhook: "Webhook",
};

export function NotificationChannels({
  initial,
  onOpenChange,
  open,
  role,
}: {
  initial: ChannelRow[];
  /** The dialog's state lives in the ROUTE: its opening button is mounted
   *  in the AppShell header, not here. */
  onOpenChange: (open: boolean) => void;
  open: boolean;
  role: string | null;
}) {
  const known = role && role in roles ? (role as RoleName) : null;
  const canManage = useCan(known, "notification", "manage");
  const {
    data: rows,
    isEmpty,
    refresh,
  } = useResourceList(queries.channels, initial);

  const handleOpen = useCallback(() => onOpenChange(true), [onOpenChange]);

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Hidden when the list is empty: the empty state already explains
          what a channel is for, and two explanations stacked one above the
          other would compete — on top of pushing the empty state off
          screen. */}
      {canManage ? (
        <AddChannelDialog
          onDone={refresh}
          onOpenChange={onOpenChange}
          open={open}
        />
      ) : null}

      <SettingsList isEmpty={isEmpty}>
        <SettingsList.Empty>
          <SettingsList.EmptyMedia>
            <IconStack>
              <BellIcon className="size-5" />
            </IconStack>
          </SettingsList.EmptyMedia>
          <SettingsList.EmptyHeader>
            <SettingsList.EmptyTitle>No channels</SettingsList.EmptyTitle>
            <SettingsList.EmptyDescription>
              Without a channel, a deploy reverted by the watch is only visible
              if someone opens the dashboard.
            </SettingsList.EmptyDescription>
          </SettingsList.EmptyHeader>
          {canManage ? (
            <SettingsList.EmptyContent>
              <Button onClick={handleOpen}>Add channel</Button>
            </SettingsList.EmptyContent>
          ) : null}
        </SettingsList.Empty>

        <SettingsList.Body>
          <p className="mb-4 text-muted-foreground text-sm">
            Noddle alerts you when a deploy fails, when the watch takes over, or
            when a backup breaks.
          </p>
          <ItemGroup>
            {rows.map((channel) => (
              <ChannelLine
                canManage={canManage}
                channel={channel}
                key={channel.id}
                onDone={refresh}
              />
            ))}
          </ItemGroup>
        </SettingsList.Body>
      </SettingsList>
    </div>
  );
}

function ChannelLine({
  canManage,
  channel,
  onDone,
}: {
  canManage: boolean;
  channel: ChannelRow;
  onDone: () => void;
}) {
  const test = useMutation({
    mutationFn: () => testChannel({ data: { channelId: channel.id } }),
    onSuccess: onDone,
  });
  const remove = useMutation({
    mutationFn: () => deleteChannel({ data: { channelId: channel.id } }),
    onSuccess: onDone,
  });
  const toggle = useMutation({
    mutationFn: () =>
      updateChannel({
        data: {
          channelId: channel.id,
          enabled: !channel.enabled,
          kind: channel.kind,
          name: channel.name,
          notifySuccess: channel.notifySuccess,
        },
      }),
    onSuccess: onDone,
  });

  const handleTest = useCallback(() => test.mutate(), [test]);
  const handleRemove = useCallback(() => remove.mutate(), [remove]);
  const handleToggle = useCallback(() => toggle.mutate(), [toggle]);

  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>
          {channel.name}
          <Badge variant="outline">{KIND_LABEL[channel.kind]}</Badge>
          {channel.enabled ? null : <Badge variant="outline">muted</Badge>}
          {channel.notifySuccess ? (
            <Badge variant="outline">success included</Badge>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          <ChannelState channel={channel} />
        </ItemDescription>
      </ItemContent>

      {canManage ? (
        <ItemActions>
          <Button
            disabled={test.isPending}
            onClick={handleTest}
            size="sm"
            variant="outline"
          >
            {test.isPending ? <Spinner /> : null}
            Test
          </Button>
          <Button
            disabled={toggle.isPending}
            onClick={handleToggle}
            size="sm"
            variant="outline"
          >
            {channel.enabled ? "Mute" : "Unmute"}
          </Button>
          <Button
            disabled={remove.isPending}
            onClick={handleRemove}
            size="sm"
            variant="ghost"
          >
            Delete
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  );
}

/**
 * The state of the last send.
 *
 * Three distinct cases, and the third is the one we don't want to confuse
 * with success: never sent anything. A channel that was added but never
 * triggered is NOT a working channel — it simply hasn't had the chance to
 * fail yet.
 */
function ChannelState({ channel }: { channel: ChannelRow }) {
  if (channel.lastError) {
    return (
      <span className="truncate text-destructive text-xs">
        Failing — {channel.lastError}
      </span>
    );
  }
  if (channel.lastSuccessAt) {
    return (
      <span className="text-muted-foreground text-xs">
        Last sent <RelativeTime iso={channel.lastSuccessAt} />
      </span>
    );
  }
  return (
    <span className="text-muted-foreground text-xs">
      Never used — test it to find out whether it works
    </span>
  );
}

type ChannelFormValues = z.input<typeof notificationChannelSchema>;

function AddChannelDialog({
  onDone,
  onOpenChange,
  open,
}: {
  onDone: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const add = useMutation({
    mutationFn: (value: ChannelFormValues) =>
      addChannel({
        data: {
          kind: value.kind,
          name: value.name,
          notifySuccess: value.notifySuccess ?? false,
          url: value.url,
        },
      }),
    onSuccess: () => {
      onOpenChange(false);
      onDone();
    },
  });

  const form = useAppForm({
    defaultValues: {
      kind: "discord",
      name: "",
      notifySuccess: false,
      url: "",
    } as ChannelFormValues,
    onSubmit: ({ value }) => add.mutateAsync(value),
    validators: { onDynamic: notificationChannelSchema },
  });

  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [open, form.reset]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogForm onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add a channel</DialogTitle>
            <DialogDescription>
              The URL is encrypted at rest and never shown again — whoever holds
              it can post in the channel.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <FieldGroup>
              {/* The radio engine stays as pills — a deliberate UI choice,
                  not a `f.FieldSelect` — but wired to the field via
                  `AppField`'s render-prop: the primitive doesn't dictate the
                  shape of the control, only the state. */}
              <form.AppField name="kind">
                {(field) => (
                  <Field>
                    <Label id="kindLabel">Type</Label>
                    {/* `role="radiogroup"`: three plain buttons told no one
                        that they were mutually exclusive, nor which one was
                        selected. */}
                    <div
                      aria-labelledby="kindLabel"
                      className="flex gap-1"
                      role="radiogroup"
                    >
                      {KINDS.map((option) => (
                        <KindButton
                          active={field.state.value === option.value}
                          key={option.value}
                          label={option.label}
                          onSelect={field.handleChange}
                          value={option.value}
                        />
                      ))}
                    </div>
                  </Field>
                )}
              </form.AppField>

              <form.AppField name="name">
                {(f) => (
                  <f.FieldText
                    addonStart={<TagIcon />}
                    label="Name"
                    placeholder="Production alerts"
                    required
                  />
                )}
              </form.AppField>

              <form.AppField name="url">
                {(f) => (
                  <f.FieldText
                    addonStart={<LinkIcon />}
                    label="URL"
                    placeholder="https://discord.com/api/webhooks/…"
                    required
                    type="url"
                  />
                )}
              </form.AppField>

              <form.AppField name="notifySuccess">
                {(field) => (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={field.state.value}
                      id="notifySuccess"
                      // `checked` can be `"indeterminate"`; the field only
                      // knows about the boolean.
                      // biome-ignore lint/performance/noJsxPropsBind: adapts the type of `onCheckedChange` to the field
                      onCheckedChange={(checked) =>
                        field.handleChange(checked === true)
                      }
                    />
                    <Label
                      className="font-normal text-sm"
                      htmlFor="notifySuccess"
                    >
                      Also notify on successful deploys
                    </Label>
                  </div>
                )}
              </form.AppField>

              {add.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {errorMessage(add.error, "channel rejected")}
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </DialogBody>

          <DialogFooter>
            <Button disabled={add.isPending} type="submit">
              {add.isPending ? <Spinner /> : null}
              Add channel
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

function KindButton({
  active,
  label,
  onSelect,
  value,
}: {
  active: boolean;
  label: string;
  onSelect: (value: ChannelRow["kind"]) => void;
  value: ChannelRow["kind"];
}) {
  const handleClick = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Button
      aria-checked={active}
      onClick={handleClick}
      role="radio"
      size="sm"
      type="button"
      variant={active ? "secondary" : "ghost"}
    >
      {label}
    </Button>
  );
}
