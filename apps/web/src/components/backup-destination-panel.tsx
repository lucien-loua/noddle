// La destination S3 de l'installation. Une seule, par décision.
//
// Le champ « clé secrète » part TOUJOURS vide, même quand une destination est
// déjà enregistrée : elle ne ressort jamais du serveur, pas même chiffrée —
// même règle que le mot de passe d'une base. Le laisser vide conserve celle
// d'avant, ce que le libellé dit explicitement plutôt que de le laisser
// deviner.
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { type RoleName, roles } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { type DestinationRow, saveDestination } from "@/server/backups";

interface Props {
  initial: DestinationRow | null;
  role: string | null;
}

export function BackupDestinationPanel({ initial, role }: Props) {
  const known = role && role in roles ? (role as RoleName) : null;
  // `backup:create` — la même permission que déclencher une sauvegarde
  // manuelle, côté serveur. La destination est de la configuration, pas un
  // secret qu'on cache : `getDestination` reste lisible par tous, seule
  // l'écriture est gardée.
  const canEdit = useCan(known, "backup", "create");
  const [endpoint, setEndpoint] = useState(initial ? initial.endpoint : "");
  const [bucket, setBucket] = useState(initial ? initial.bucket : "");
  const [region, setRegion] = useState(initial ? initial.region : "us-east-1");
  const [prefix, setPrefix] = useState(initial ? initial.prefix : "");
  const [accessKeyId, setAccessKeyId] = useState(
    initial ? initial.accessKeyId : ""
  );
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [forcePathStyle, setForcePathStyle] = useState(
    initial ? initial.forcePathStyle : true
  );

  const save = useMutation({
    mutationFn: () =>
      saveDestination({
        data: {
          accessKeyId,
          bucket,
          endpoint,
          forcePathStyle,
          prefix,
          region,
          secretAccessKey,
        },
      }),
  });

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      save.mutate();
    },
    [save]
  );

  const onEndpoint = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setEndpoint(e.target.value),
    []
  );
  const onBucket = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setBucket(e.target.value),
    []
  );
  const onRegion = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setRegion(e.target.value),
    []
  );
  const onPrefix = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setPrefix(e.target.value),
    []
  );
  const onAccessKey = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setAccessKeyId(e.target.value),
    []
  );
  const onSecret = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setSecretAccessKey(e.target.value),
    []
  );
  const onPathStyle = useCallback(
    (checked: boolean) => setForcePathStyle(checked),
    []
  );

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      {/* Deux groupes, deux questions : OÙ les sauvegardes partent, et avec
          QUELLES clés. À plat, les six champs se lisaient comme une seule
          liste indifférenciée alors que la moitié sont des secrets.

          `max-w-sm` sur chaque CHAMP (pas sur le panneau) : un panneau plein
          largeur reste cohérent avec le reste du dashboard, mais un champ
          qui contient une valeur courte n'a aucune raison d'en épouser toute
          la largeur — c'était le défaut d'avant, une URL de vingt caractères
          étirée sur mille pixels. */}
      <FieldSet disabled={!canEdit}>
        <FieldLegend variant="label">Location</FieldLegend>
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field className="max-w-sm">
            <FieldLabel htmlFor="endpoint">Endpoint</FieldLabel>
            <Input
              id="endpoint"
              onChange={onEndpoint}
              placeholder="https://s3.example.com"
              required
              value={endpoint}
            />
          </Field>

          <Field className="max-w-sm">
            <FieldLabel htmlFor="bucket">Bucket</FieldLabel>
            <Input
              id="bucket"
              onChange={onBucket}
              placeholder="noddle-backups"
              required
              value={bucket}
            />
          </Field>

          <Field className="max-w-sm">
            <FieldLabel htmlFor="region">Region</FieldLabel>
            <Input id="region" onChange={onRegion} required value={region} />
          </Field>

          <Field className="max-w-sm">
            <FieldLabel htmlFor="prefix">Prefix (optional)</FieldLabel>
            <Input
              id="prefix"
              onChange={onPrefix}
              placeholder="backups"
              value={prefix}
            />
          </Field>
        </div>
      </FieldSet>

      <FieldSet disabled={!canEdit}>
        <FieldLegend variant="label">Credentials</FieldLegend>
        <FieldDescription>
          Encrypted at rest and never sent back to the browser. Noddle&apos;s
          own servers push the dumps, so these never travel to a target machine.
        </FieldDescription>
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field className="max-w-sm">
            <FieldLabel htmlFor="accessKeyId">Access key ID</FieldLabel>
            <Input
              id="accessKeyId"
              onChange={onAccessKey}
              required
              value={accessKeyId}
            />
          </Field>

          <Field className="max-w-sm">
            <FieldLabel htmlFor="secretAccessKey">Secret access key</FieldLabel>
            <Input
              id="secretAccessKey"
              onChange={onSecret}
              placeholder={initial ? "unchanged" : ""}
              required={!initial}
              type="password"
              value={secretAccessKey}
            />
            {initial ? (
              <FieldDescription>
                Leave empty to keep the stored key.
              </FieldDescription>
            ) : null}
          </Field>
        </div>

        <Field orientation="horizontal">
          <Checkbox
            checked={forcePathStyle}
            id="pathStyle"
            onCheckedChange={onPathStyle}
          />
          <FieldLabel className="font-normal" htmlFor="pathStyle">
            Path-style addressing (required outside Amazon S3)
          </FieldLabel>
        </Field>
      </FieldSet>

      {save.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {errorMessage(save.error, "destination rejected")}
          </AlertDescription>
        </Alert>
      ) : null}

      {save.isSuccess ? (
        <Alert>
          <AlertDescription>
            Destination tested and saved — write, read and delete all verified
            against the bucket.
          </AlertDescription>
        </Alert>
      ) : null}

      {canEdit ? (
        <Button disabled={save.isPending} type="submit">
          {save.isPending ? <Spinner /> : null}
          Test and save
        </Button>
      ) : null}
    </form>
  );
}
