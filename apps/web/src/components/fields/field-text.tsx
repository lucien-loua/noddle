import type { ChangeEvent, ComponentProps, ReactNode } from "react";
import { useCallback, useId } from "react";

import { FieldShell, fieldDisplayState } from "@/components/fields/field-shell";
import { useFieldContext } from "@/components/fields/lib/context";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";

type TextFieldProps = Omit<
  ComponentProps<typeof InputGroupInput>,
  "aria-describedby" | "aria-invalid" | "id" | "onChange" | "required" | "value"
> & {
  /** Placed at the end of the field — a unit, a button. */
  addonEnd?: ReactNode;
  /** Placed at the start of the field — a prefix, an icon. */
  addonStart?: ReactNode;
  description?: string;
  label: ReactNode;
  /** Marks the label and sets `aria-required` — NEVER the native
   *  `required` attribute, which would let the browser judge the field
   *  before Zod does. */
  required?: boolean;
};

export function FieldText({
  addonEnd,
  addonStart,
  description,
  label,
  required,
  ...inputProps
}: TextFieldProps) {
  const field = useFieldContext<string>();
  const id = useId();
  const errorId = `${id}-error`;
  const { errors, invalid } = fieldDisplayState(field.state.meta);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => field.handleChange(e.target.value),
    [field]
  );

  return (
    <FieldShell
      controlId={id}
      description={description}
      errorId={errorId}
      errors={errors}
      invalid={invalid}
      label={label}
      required={required}
    >
      <InputGroup>
        {addonStart ? (
          <InputGroupAddon align="inline-start">{addonStart}</InputGroupAddon>
        ) : null}
        <InputGroupInput
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid}
          aria-required={required}
          id={id}
          name={field.name}
          onBlur={field.handleBlur}
          onChange={handleChange}
          value={field.state.value}
          {...inputProps}
        />
        {addonEnd ? (
          <InputGroupAddon align="inline-end">{addonEnd}</InputGroupAddon>
        ) : null}
      </InputGroup>
    </FieldShell>
  );
}
