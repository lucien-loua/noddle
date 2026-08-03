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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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

  const handleServiceChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => setServiceId(e.target.value),
    []
  );
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
        Attacher
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attacher à un service</DialogTitle>
          <DialogDescription>
            La chaîne de connexion est écrite comme variable d'environnement du
            service choisi — elle ne s'affiche jamais ici.
          </DialogDescription>
        </DialogHeader>

        {noServices ? (
          <Alert variant="destructive">
            <AlertDescription>
              Aucun service à attacher. Connectez d'abord un dépôt.
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
  onServiceChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  onSubmit: (e: FormEvent) => void;
  pending: boolean;
  serviceId: string;
  services: ServiceRow[];
}) {
  if (done) {
    return (
      <Alert>
        <AlertDescription>
          Attaché : <code>{done}</code> est disponible dans les variables
          d'environnement du service, prêt au prochain déploiement.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="attach-service">Service</FieldLabel>
          <select
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
            id="attach-service"
            onChange={onServiceChange}
            required
            value={serviceId}
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.project} / {s.environment} · {s.name}
              </option>
            ))}
          </select>
        </Field>

        <Field>
          <FieldLabel htmlFor="attach-key">Nom de la variable</FieldLabel>
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

      <DialogFooter className="mt-6">
        <Button disabled={pending} type="submit">
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Attacher
        </Button>
      </DialogFooter>
    </form>
  );
}
