// Le fil d'Ariane des pages de détail.
//
// Le détail vit sur sa PROPRE page, pas dans un panneau déplié sous la
// ligne : cliquer ne déplace plus rien derrière, et la position de chaque
// ligne du dashboard reste la même avant et après. Le prix de cette
// prévisibilité est qu'on quitte la liste — d'où ce fil, qui dit à la fois
// où l'on est et comment remonter.
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";

export function DetailBreadcrumb({
  environment,
  name,
  project,
}: {
  environment: string;
  name: string;
  project: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* La flèche double le premier maillon plutôt que de le remplacer :
          le fil dit OÙ l'on est, la flèche donne une cible large pour
          remonter sans viser un mot de huit caractères. */}
      <Button
        aria-label="Back to deployments"
        className="-ms-1 shrink-0"
        render={<Link to="/" />}
        size="icon-sm"
        variant="ghost"
      >
        <ArrowLeftIcon />
      </Button>

      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          {/* Le contexte s'efface sous `sm` : sur un téléphone, le nom de ce
              qu'on regarde compte plus que le chemin qui y mène, et le fil
              entier ne tiendrait pas. */}
          <BreadcrumbItem className="hidden sm:inline-flex">
            <BreadcrumbLink render={<Link to="/">Deployments</Link>} />
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden sm:block" />
          <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
            <span className="truncate">
              {project}
              <span className="text-muted-foreground/50"> / </span>
              {environment}
            </span>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden sm:block" />
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="truncate font-medium">
              {name}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}
