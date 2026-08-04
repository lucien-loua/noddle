// Attacher une base de données à un service — la seule façon d'en obtenir
// la chaîne de connexion. Elle n'apparaît jamais dans ce formulaire : le
// serveur la construit, la chiffre et l'écrit directement comme variable
// d'environnement du service choisi.
import { PlusIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import type { ServiceRow } from "@/server/dashboard";
import { attachDatabase } from "@/server/databases";

interface Props {
  databaseId: string;
  defaultKey: string;
  services: ServiceRow[];
}

export function AttachDatabaseDialog({
  databaseId,
  defaultKey,
  services,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // biome-ignore lint/suspicious/noUnnecessaryConditions: faux positif, services peut être vide
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [envVarKey, setEnvVarKey] = useState(defaultKey);

  const handleServiceChange = useCallback((next: unknown) => {
    if (typeof next === "string") {
      setServiceId(next);
    }
  }, []);
  const handleKeyChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setEnvVarKey(e.target.value),
    []
  );

  const reset = useCallback(() => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: faux positif, services peut être vide
    setServiceId(services[0]?.id ?? "");
    setEnvVarKey(defaultKey);
    setError(null);
    setDone(null);
  }, [services, defaultKey]);

  useEffect(() => {
    if (!open) {
      reset();
    }
  }, [open, reset]);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setPending(true);
      setError(null);

      try {
        const result = await attachDatabase({
          data: { databaseId, envVarKey, serviceId },
        });
        setDone(result.key);
        await router.invalidate();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPending(false);
      }
    },
    [databaseId, envVarKey, router, serviceId]
  );

  const noServices = services.length === 0;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>
        <PlusIcon data-icon="inline-start" />
        Attach
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach to a service</DialogTitle>
          <DialogDescription>
            The connection string is written as an environment variable of the
            chosen service — it is never shown here.
          </DialogDescription>
        </DialogHeader>

        {noServices ? (
          <Alert variant="destructive">
            <AlertDescription>
              No services to attach to. Connect a repository first.
            </AlertDescription>
          </Alert>
        ) : (
          <AttachBody
            done={done}
            envVarKey={envVarKey}
            error={error}
            onKeyChange={handleKeyChange}
            onServiceChange={handleServiceChange}
            onSubmit={handleSubmit}
            pending={pending}
            serviceId={serviceId}
            services={services}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AttachBody({
  done,
  envVarKey,
  error,
  onKeyChange,
  onServiceChange,
  onSubmit,
  pending,
  serviceId,
  services,
}: {
  done: string | null;
  envVarKey: string;
  error: string | null;
  onKeyChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onServiceChange: (next: unknown) => void;
  onSubmit: (e: FormEvent) => void;
  pending: boolean;
  serviceId: string;
  services: ServiceRow[];
}) {
  const serviceLabels = Object.fromEntries(
    services.map((s) => [s.id, `${s.project} / ${s.environment} · ${s.name}`])
  );

  if (done) {
    return (
      <Alert>
        <AlertDescription>
          Attached: <code>{done}</code> is now in the service environment
          variables, ready for the next deploy.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <DialogForm onSubmit={onSubmit}>
      <DialogBody>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="attach-service">Service</FieldLabel>
            <Select
              items={serviceLabels}
              onValueChange={onServiceChange}
              value={serviceId}
            >
              <SelectTrigger className="w-full" id="attach-service">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {services.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="flex flex-col gap-0.5">
                        <span>{s.name}</span>
                        <span className="font-normal text-muted-foreground text-xs">
                          {s.project} / {s.environment}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="attach-key">Variable name</FieldLabel>
            <Input
              id="attach-key"
              onChange={onKeyChange}
              required
              value={envVarKey}
            />
          </Field>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
      </DialogBody>

      <DialogFooter>
        <Button disabled={pending} type="submit">
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Attach
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}
