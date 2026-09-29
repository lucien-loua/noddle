import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { CaretRightIcon, DotsThreeIcon } from "@phosphor-icons/react";
import * as React from "react";

import { cn } from "@/lib/utils";

const Breadcrumb = ({ className, ...props }: React.ComponentProps<"nav">) => (
  <nav
    aria-label="breadcrumb"
    data-slot="breadcrumb"
    className={cn(className)}
    {...props}
  />
);

const BreadcrumbList = ({
  className,
  ...props
}: React.ComponentProps<"ol">) => (
  <ol
    data-slot="breadcrumb-list"
    className={cn(
      "flex flex-wrap items-center gap-1.5 text-sm wrap-break-word text-muted-foreground sm:gap-2.5",
      className
    )}
    {...props}
  />
);

const BreadcrumbItem = ({
  className,
  ...props
}: React.ComponentProps<"li">) => (
  <li
    data-slot="breadcrumb-item"
    className={cn("inline-flex items-center gap-1.5", className)}
    {...props}
  />
);

function BreadcrumbLink({
  className,
  render,
  ...props
}: useRender.ComponentProps<"a">) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn("transition-colors hover:text-foreground", className),
      },
      props
    ),
    render,
    state: {
      slot: "breadcrumb-link",
    },
  });
}

const BreadcrumbPage = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    data-slot="breadcrumb-page"
    role="link"
    aria-disabled="true"
    aria-current="page"
    className={cn("font-normal text-foreground", className)}
    {...props}
  />
);

const BreadcrumbSeparator = ({
  children,
  className,
  ...props
}: React.ComponentProps<"li">) => (
  <li
    data-slot="breadcrumb-separator"
    role="presentation"
    aria-hidden="true"
    className={cn("[&>svg]:size-3.5", className)}
    {...props}
  >
    {children ?? <CaretRightIcon className="rtl:rotate-180" weight="regular" />}
  </li>
);

const BreadcrumbEllipsis = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    data-slot="breadcrumb-ellipsis"
    role="presentation"
    aria-hidden="true"
    className={cn(
      "flex size-5 items-center justify-center [&>svg]:size-4",
      className
    )}
    {...props}
  >
    <DotsThreeIcon weight="regular" />
    <span className="sr-only">More</span>
  </span>
);

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
};
