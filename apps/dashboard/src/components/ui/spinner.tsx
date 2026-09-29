import { SpinnerIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

const Spinner = ({ className, ...props }: React.ComponentProps<"svg">) => (
  <SpinnerIcon
    aria-label="Loading"
    className={cn("size-4 animate-spin", className)}
    data-slot="spinner"
    role="status"
    {...props}
  />
);

export { Spinner };
