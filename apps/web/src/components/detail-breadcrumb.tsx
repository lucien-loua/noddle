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

/**
 * The screen we came from. Paths are enumerated rather than taken as a
 * `string`: `Link` checks them against the route tree, and a typo must
 * show up at typecheck, not on click.
 *
 * The second form carries PARAMETERS, because the real parent of a
 * service, a stack, or a database is its ENVIRONMENT — not a global
 * screen. Going back up from a service to /deployments was already wrong,
 * and has become outright misleading now that that screen is a history
 * view: you'd be "going back up" to a list where the service doesn't even
 * appear as such.
 */
type Parent =
  | { label: string; to: "/" | "/projects" | "/servers" }
  | {
      environmentId: string;
      label: string;
      projectId: string;
      to: "/projects/$projectId/$environmentId";
    };

const PROJECTS: Parent = { label: "Projects", to: "/projects" };

/** The parent's link, rendered here because the parameterized variant and
 *  the plain one don't have the same signature for `Link`. */
function ParentLink({
  children,
  className,
  parent,
}: {
  children?: React.ReactNode;
  className?: string;
  parent: Parent;
}) {
  if (parent.to === "/projects/$projectId/$environmentId") {
    return (
      <Link
        className={className}
        params={{
          environmentId: parent.environmentId,
          projectId: parent.projectId,
        }}
        to={parent.to}
      >
        {children}
      </Link>
    );
  }
  return (
    <Link className={className} to={parent.to}>
      {children}
    </Link>
  );
}

export function DetailBreadcrumb({
  environment,
  name,
  parent = PROJECTS,
  project,
}: {
  /** Absent for a SERVER: a machine belongs to neither a project nor an
   *  environment, and inventing one for it would be one more empty field to
   *  read. The link then disappears, it doesn't go blank. */
  environment?: string;
  name: string;
  parent?: Parent;
  project?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* The arrow duplicates the first breadcrumb link rather than
          replacing it: the trail says WHERE you are, the arrow gives a
          large target to go back up without aiming for an eight-character
          word. */}
      {/* `nativeButton={false}`: this is a LINK rendered with a button's
          styling. Without this, Base UI assumes a native <button> and
          warns — rightly — that it loses its semantics. Here the intended
          semantics really are a link's: it navigates. */}
      <Button
        aria-label={`Back to ${parent.label.toLowerCase()}`}
        className="-ms-1 shrink-0"
        nativeButton={false}
        render={<ParentLink parent={parent} />}
        size="icon"
        variant="ghost"
      >
        <ArrowLeftIcon weight="regular" />
      </Button>

      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          {/* Context fades away under `sm`: on a phone, the name of what
              you're looking at matters more than the path that led there,
              and the whole trail wouldn't fit. */}
          <BreadcrumbItem className="hidden sm:inline-flex">
            <BreadcrumbLink
              render={<ParentLink parent={parent}>{parent.label}</ParentLink>}
            />
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden sm:block" />
          {project && environment ? (
            <>
              <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
                <span className="truncate">
                  {project}
                  <span className="text-muted-foreground/50"> / </span>
                  {environment}
                </span>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:block" />
            </>
          ) : null}
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
