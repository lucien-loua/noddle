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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { type DestinationRow, saveDestination } from "@/server/backups";

interface Props {
  initial: DestinationRow | null;
}

export function BackupDestinationPanel({ initial }: Props) {
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
    <form className="max-w-2xl space-y-6" onSubmit={handleSubmit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="endpoint">Point de terminaison</Label>
          <Input
            id="endpoint"
            onChange={onEndpoint}
            placeholder="https://s3.example.com"
            required
            value={endpoint}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="bucket">Compartiment</Label>
          <Input
            id="bucket"
            onChange={onBucket}
            placeholder="noddle-sauvegardes"
            required
            value={bucket}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="region">Région</Label>
          <Input id="region" onChange={onRegion} required value={region} />
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="prefix">Préfixe (optionnel)</Label>
          <Input
            id="prefix"
            onChange={onPrefix}
            placeholder="sauvegardes"
            value={prefix}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="accessKeyId">Clé d'accès</Label>
          <Input
            id="accessKeyId"
            onChange={onAccessKey}
            required
            value={accessKeyId}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="secretAccessKey">Clé secrète</Label>
          <Input
            id="secretAccessKey"
            onChange={onSecret}
            placeholder={initial ? "inchangée" : ""}
            required={!initial}
            type="password"
            value={secretAccessKey}
          />
          {initial ? (
            <p className="text-muted-foreground text-xs">
              Laisser vide conserve la clé enregistrée — elle n'est jamais
              renvoyée au navigateur.
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          checked={forcePathStyle}
          id="pathStyle"
          onCheckedChange={onPathStyle}
        />
        <Label className="font-normal text-sm" htmlFor="pathStyle">
          Style chemin (requis hors du S3 d'Amazon)
        </Label>
      </div>

      {save.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {save.error instanceof Error
              ? save.error.message
              : "destination refusée"}
          </AlertDescription>
        </Alert>
      ) : null}

      {save.isSuccess ? (
        <Alert>
          <AlertDescription>
            Destination éprouvée et enregistrée — écriture, lecture et
            suppression vérifiées sur le compartiment.
          </AlertDescription>
        </Alert>
      ) : null}

      <Button disabled={save.isPending} type="submit">
        {save.isPending ? <Spinner /> : null}
        Tester et enregistrer
      </Button>
    </form>
  );
}
