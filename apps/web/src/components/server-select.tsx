// Le choix du serveur cible — identique dans les trois dialogues qui
// créent quelque chose à déployer (dépôt, pile, base).
//
// Partagé plutôt que recopié : les trois posent la MÊME question et
// doivent y répondre pareil. Un `<select>` natif y traînait, seul élément
// de formulaire à ne pas suivre le préréglage — sa hauteur, son rayon et
// sa police venaient d'une classe écrite à la main, et il ignorait le
// mode sombre du menu.
import { useCallback, useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ServerView } from "@/server/servers";

export function ServerSelect({
  id,
  onChange,
  servers,
  value,
}: {
  id: string;
  onChange: (serverId: string) => void;
  servers: ServerView[];
  value: string;
}) {
  // `items` : sans lui, Base UI affiche la VALEUR — ici un uuid. Le
  // déclencheur doit montrer le nom de la machine, pas son identifiant.
  const items = useMemo(
    () =>
      Object.fromEntries(servers.map((s) => [s.id, `${s.name} · ${s.host}`])),
    [servers]
  );

  const handleChange = useCallback(
    (next: unknown) => {
      if (typeof next === "string") {
        onChange(next);
      }
    },
    [onChange]
  );

  return (
    <Select items={items} onValueChange={handleChange} value={value}>
      <SelectTrigger className="w-full" id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {servers.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              <span className="flex flex-col gap-0.5">
                <span>{s.name}</span>
                <span className="font-normal text-muted-foreground text-xs">
                  {s.host}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
