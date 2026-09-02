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
  InputGroupTextarea,
} from "@/components/ui/input-group";

type TextareaFieldProps = Omit<
  ComponentProps<typeof InputGroupTextarea>,
  "aria-describedby" | "aria-invalid" | "id" | "onChange" | "required" | "value"
> & {
  addonEnd?: ReactNode;
  description?: string;
  label: ReactNode;
  required?: boolean;
};

export function FieldTextarea({
  addonEnd,
  description,
  label,
  required,
  ...textareaProps
}: TextareaFieldProps) {
  const field = useFieldContext<string>();
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const { errors, invalid } = fieldDisplayState(field.state.meta);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => field.handleChange(e.target.value),
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
        <InputGroupTextarea
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
          {...textareaProps}
        />
        {addonEnd ? (
          <InputGroupAddon align="block-end">{addonEnd}</InputGroupAddon>
        ) : null}
      </InputGroup>
    </FieldShell>
  );
}
