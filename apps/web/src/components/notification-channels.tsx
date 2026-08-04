import { BellIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import {
  addChannel,
  type ChannelRow,
  deleteChannel,
  getChannels,
  testChannel,
  updateChannel,
} from "@/server/notifications";

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
  role,
}: {
  initial: ChannelRow[];
  role: string | null;
}) {
  const known = role && role in roles ? (role as RoleName) : null;
  const canManage = useCan(known, "notification", "manage");
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const channels = useQuery({
    initialData: initial,
    queryFn: () => getChannels(),
    queryKey: ["channels"],
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["channels"] }),
    [queryClient]
  );
  const handleOpen = useCallback(() => setOpen(true), []);

  const rows = channels.data ?? [];

  return (
    // `/notifications` est un écran à un seul panneau : quand il est vide,
    // le rendre plein hauteur (`h-full`, hérité de `.scroll-fade` qui a une
    // hauteur réelle) évite qu'« Aucun canal » flotte en haut d'une page
    // sinon nue. Un tableau plein, lui, n'a pas besoin de la hauteur — il
    // s'arrête où finit sa dernière ligne.
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          Noddle alerts you when a deploy fails, when the watch takes over, or
          when a backup breaks.
        </p>
        {canManage ? (
          <Button onClick={handleOpen} size="sm">
            Add channel
          </Button>
        ) : null}
      </div>

      {canManage ? (
        <AddChannelDialog onDone={refresh} onOpenChange={setOpen} open={open} />
      ) : null}

      {rows.length === 0 ? (
        <Empty>
          <EmptyMedia variant="icon">
            <BellIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No channels</EmptyTitle>
            <EmptyDescription>
              Without a channel, a deploy reverted by the watch is only visible
              if someone opens the dashboard.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="divide-y rounded-md border">
          {rows.map((channel) => (
            <ChannelLine
              canManage={canManage}
              channel={channel}
              key={channel.id}
              onDone={refresh}
            />
          ))}
        </div>
      )}
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
  // Couper plutôt que supprimer : on garde l'URL et l'historique d'erreur, ce
  // qui permet de faire taire un canal bruyant sans avoir à le reconfigurer.
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
    <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">{channel.name}</span>
          <Badge variant="outline">{KIND_LABEL[channel.kind]}</Badge>
          {channel.enabled ? null : <Badge variant="outline">muted</Badge>}
          {channel.notifySuccess ? (
            <Badge variant="outline">success included</Badge>
          ) : null}
        </span>
        <ChannelState channel={channel} />
      </span>

      {canManage ? (
        <>
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
        </>
      ) : null}
    </div>
  );
}

/**
 * L'état du dernier envoi.
 *
 * Trois cas distincts, et le troisième est celui qu'on ne veut pas confondre
 * avec un succès : jamais rien envoyé. Un canal ajouté puis jamais sollicité
 * n'est PAS un canal qui marche — il n'a simplement pas encore eu l'occasion
 * de rater.
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

function AddChannelDialog({
  onDone,
  onOpenChange,
  open,
}: {
  onDone: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [kind, setKind] = useState<ChannelRow["kind"]>("discord");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [notifySuccess, setNotifySuccess] = useState(false);

  const add = useMutation({
    mutationFn: () => addChannel({ data: { kind, name, notifySuccess, url } }),
    onSuccess: () => {
      setName("");
      setUrl("");
      onOpenChange(false);
      onDone();
    },
  });

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      add.mutate();
    },
    [add]
  );
  const handleName = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    []
  );
  const handleUrl = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value),
    []
  );
  const handleSuccess = useCallback(
    (checked: boolean) => setNotifySuccess(checked),
    []
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add a channel</DialogTitle>
            <DialogDescription>
              The URL is encrypted at rest and never shown again — whoever holds
              it can post in the channel.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              {/* `role="radiogroup"` : trois boutons sans plus ne disaient à
                  personne qu'ils s'excluaient ni lequel était choisi — un
                  lecteur d'écran entendait trois boutons identiques. Le
                  style reste des pastilles, la sémantique devient un vrai
                  groupe de radios. */}
              <Label id="kindLabel">Type</Label>
              <div
                aria-labelledby="kindLabel"
                className="flex gap-1"
                role="radiogroup"
              >
                {KINDS.map((option) => (
                  <KindButton
                    active={kind === option.value}
                    key={option.value}
                    label={option.label}
                    onSelect={setKind}
                    value={option.value}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="channelName">Name</Label>
              <Input
                id="channelName"
                onChange={handleName}
                placeholder="Production alerts"
                required
                value={name}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="channelUrl">URL</Label>
              <Input
                id="channelUrl"
                onChange={handleUrl}
                placeholder="https://discord.com/api/webhooks/…"
                required
                type="url"
                value={url}
              />
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                checked={notifySuccess}
                id="notifySuccess"
                onCheckedChange={handleSuccess}
              />
              <Label className="font-normal text-sm" htmlFor="notifySuccess">
                Also notify on successful deploys
              </Label>
            </div>

            {add.isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {errorMessage(add.error, "channel rejected")}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter>
            <Button disabled={add.isPending} type="submit">
              {add.isPending ? <Spinner /> : null}
              Add channel
            </Button>
          </DialogFooter>
        </form>
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
