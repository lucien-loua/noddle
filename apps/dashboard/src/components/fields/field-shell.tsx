import type { ReactNode } from "react";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";

export function toFieldErrors(errors: unknown[]): { message?: string }[] {
  return errors
    .filter((e) => e !== undefined && e !== null)
    .map((e) =>
      typeof e === "string" ? { message: e } : (e as { message?: string })
    );
}

export function fieldDescribedBy({
  description,
  descriptionId,
  errorId,
  invalid,
}: {
  description?: string;
  descriptionId: string;
  errorId: string;
  invalid: boolean;
}): string | undefined {
  const ids = [
    description ? descriptionId : null,
    invalid ? errorId : null,
  ].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export interface FieldShellProps {
  children: ReactNode;
  controlId: string;
  description?: string;
  descriptionId: string;
  errorId: string;
  errors: { message?: string }[];
  invalid: boolean;
  label: ReactNode;
  required?: boolean;
}

export function FieldShell({
  children,
  controlId,
  description,
  descriptionId,
  errorId,
  errors,
  invalid,
  label,
  required,
}: FieldShellProps) {
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={controlId}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
      </FieldLabel>
      {children}
      {description ? (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      ) : null}
      {invalid ? <FieldError errors={errors} id={errorId} /> : null}
    </Field>
  );
}

export function fieldDisplayState(meta: {
  errors: unknown[];
  isTouched: boolean;
  isValid: boolean;
}) {
  const invalid = meta.isTouched && !meta.isValid;
  return {
    errors: invalid ? toFieldErrors(meta.errors) : [],
    invalid,
  };
}
