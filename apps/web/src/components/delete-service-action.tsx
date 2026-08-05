// Supprimer un service : le bouton, la confirmation et la mutation ensemble.
//
// Le tout vit ICI et non dans la route, qui portait déjà trop d'état — Biome
// l'a signalé, à raison. La route ne veut savoir qu'une chose : c'est parti.
//
// Le nom à retaper est envoyé au SERVEUR, qui le revérifie. Ce composant n'est
// pas le garde-fou, il en est la politesse — même règle que la restauration.
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import { deleteService } from "@/server/services";

export function DeleteServiceAction({
  onDeleted,
  onError,
  role,
  serviceId,
  serviceName,
}: {
  onDeleted: () => void;
  onError: (message: string) => void;
  role: RoleName | null;
  serviceId: string;
  serviceName: string;
}) {
  // La permission est décidée ICI, avec l'action qu'elle garde, plutôt que par
  // un ternaire de plus dans la route — qui portait déjà trop de branches.
  // Politesse seulement : `deleteService` la revérifie côté serveur.
  const canDelete = useCan(role, "service", "delete");
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  const remove = useMutation({
    mutationFn: (confirmName: string) =>
      deleteService({ data: { confirmName, serviceId } }),
    onError: (e: Error) => {
      setOpen(false);
      onError(errorMessage(e, "deletion failed"));
    },
    onSuccess: onDeleted,
  });

  const handleOpen = useCallback(() => {
    // Remis à zéro à CHAQUE ouverture : sans ça, une saisie correcte laissée
    // d'une tentative précédente rendrait le bouton actif d'emblée, et la
    // confirmation ne confirmerait plus rien.
    setTyped("");
    setOpen(true);
  }, []);
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setTyped(e.target.value),
    []
  );
  const handleConfirm = useCallback(
    () => remove.mutate(typed),
    [remove, typed]
  );

  // Après les hooks, jamais avant : leur ordre doit être stable d'un rendu à
  // l'autre, sinon React perd le fil de l'état.
  if (!canDelete) {
    return null;
  }

  return (
    <>
      <Button onClick={handleOpen} size="xs" variant="outline">
        Delete
      </Button>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {serviceName}?</DialogTitle>
            {/* Dire ce qui part, pas « êtes-vous sûr ». L'historique et les
                images sont ce que personne ne peut reconstituer. */}
            <DialogDescription>
              The running container is stopped and removed, along with every
              deployment in its history, its build logs, its environment
              variables and its images in the registry.{" "}
              <strong>This cannot be undone.</strong>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="confirmServiceName">
              Type <code className="font-mono">{serviceName}</code> to confirm
            </Label>
            <Input
              autoComplete="off"
              id="confirmServiceName"
              onChange={handleChange}
              value={typed}
            />
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              disabled={typed !== serviceName || remove.isPending}
              onClick={handleConfirm}
              variant="destructive"
            >
              Delete service
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
