import type { ReactNode } from "react";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";

/**
 * What the preset's `FieldError` expects: a list of objects with `message`.
 *
 * TanStack returns Standard Schema `issues` (so already `{ message }`) when
 * validation comes from a Zod schema, but a BARE STRING when it comes from a
 * hand-written validator. Both forms are legitimate, and without this
 * normalization the second would render empty — an error message silently
 * swallowed, exactly what this product forbids.
 */
export function toFieldErrors(errors: unknown[]): { message?: string }[] {
  return errors
    .filter((e) => e !== undefined && e !== null)
    .map((e) =>
      typeof e === "string" ? { message: e } : (e as { message?: string })
    );
}

export interface FieldShellProps {
  children: ReactNode;
  controlId: string;
  /** Displayed as long as no error replaces it: the two occupy the same
   *  line, and keeping the hint under an error message would drown it out. */
  description?: string;
  errorId: string;
  errors: { message?: string }[];
  invalid: boolean;
  /** Most often a string, but an embedded `<code>` ("type X to confirm")
   *  is a `<label>` just as valid as any other. */
  label: ReactNode;
  /** Visual marker ONLY — never the HTML `required` attribute, which
   *  triggers the browser's native validation (the "Please fill out this
   *  field" bubble) before TanStack Form gets a chance, and thus before
   *  Zod. The real control remains `aria-required`, set by the caller on
   *  the field. */
  required?: boolean;
}

export function FieldShell({
  children,
  controlId,
  description,
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
      {invalid ? (
        <FieldError errors={errors} id={errorId} />
      ) : (
        description && <FieldDescription>{description}</FieldDescription>
      )}
    </Field>
  );
}

/**
 * A field's display state, derived once.
 *
 * `isTouched && !isValid` is the documented idiom, not "the errors list is
 * non-empty": `isValid` accounts for an async validation still in flight,
 * where the two don't say the same thing.
 *
 * **Errors only appear once the field has been TOUCHED**, which reproduces
 * the previous behavior without having to code it: as measured in
 * `form-core`, `handleSubmit` marks all fields as touched before
 * validating — so a submission surfaces messages just like the manual
 * `validate()` used to, except that fixing a field clears ITS message on
 * its own.
 */
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
