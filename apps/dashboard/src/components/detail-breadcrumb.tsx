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

type Parent =
  | { label: string; to: "/" | "/projects" | "/servers" }
  | {
      environmentId: string;
      label: string;
      projectId: string;
      to: "/projects/$projectId/$environmentId";
    };

const PROJECTS: Parent = { label: "Projects", to: "/projects" };

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
  environment?: string;
  name: string;
  parent?: Parent;
  project?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
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
