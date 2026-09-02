import type { ChangeEvent, ComponentProps, ReactNode } from "react";
import { useCallback, useId } from "react";

import {
  FieldShell,
  fieldDescribedBy,
  fieldDisplayState,
} from "@/components/fields/field-shell";
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
  addonEnd?: ReactNode;
  addonStart?: ReactNode;
  description?: string;
  label: ReactNode;
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
  const descriptionId = `${id}-description`;
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
      descriptionId={descriptionId}
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
          aria-describedby={fieldDescribedBy({
            description,
            descriptionId,
            errorId,
            invalid,
          })}
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
