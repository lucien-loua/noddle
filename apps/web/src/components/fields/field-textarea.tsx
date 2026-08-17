import type { ChangeEvent, ComponentProps, ReactNode } from "react";
import { useCallback, useId } from "react";

import { FieldShell, fieldDisplayState } from "@/components/fields/field-shell";
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
  /** At the bottom of the field rather than inline: on a textarea,
   *  `block-end` is the alignment the preset provides for (counter, short
   *  hint). */
  addonEnd?: ReactNode;
  description?: string;
  label: ReactNode;
  /** Marks the label and sets `aria-required` — NEVER the native
   *  `required` attribute, which would let the browser judge the field
   *  before Zod does. */
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
      errorId={errorId}
      errors={errors}
      invalid={invalid}
      label={label}
      required={required}
    >
      <InputGroup>
        <InputGroupTextarea
          aria-describedby={invalid ? errorId : undefined}
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
