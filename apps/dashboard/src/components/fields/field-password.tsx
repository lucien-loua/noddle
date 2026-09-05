import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import type { ChangeEvent, ComponentProps, ReactNode } from "react";
import { useCallback, useId, useState } from "react";

import {
  FieldShell,
  fieldDescribedBy,
  fieldDisplayState,
} from "@/components/fields/field-shell";
import { useFieldContext } from "@/components/fields/lib/context";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

type PasswordFieldProps = Omit<
  ComponentProps<typeof InputGroupInput>,
  | "aria-describedby"
  | "aria-invalid"
  | "id"
  | "onChange"
  | "required"
  | "type"
  | "value"
> & {
  addonStart?: ReactNode;
  addonEnd?: ReactNode;
  description?: string;
  label: ReactNode;
  required?: boolean;
};

export function FieldPassword({
  addonEnd,
  addonStart,
  description,
  label,
  required,
  ...inputProps
}: PasswordFieldProps) {
  const field = useFieldContext<string>();
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const { errors, invalid } = fieldDisplayState(field.state.meta);
  const [revealed, setRevealed] = useState(false);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => field.handleChange(e.target.value),
    [field]
  );
  const handleReveal = useCallback(() => setRevealed((v) => !v), []);

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
          className="font-mono"
          id={id}
          name={field.name}
          onBlur={field.handleBlur}
          onChange={handleChange}
          type={revealed ? "text" : "password"}
          value={field.state.value}
          {...inputProps}
        />
        <InputGroupAddon align="inline-end">
          {addonEnd}
          <InputGroupButton
            aria-label={revealed ? "Hide the password" : "Reveal the password"}
            onClick={handleReveal}
            size="icon-xs"
          >
            {revealed ? <EyeSlashIcon /> : <EyeIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </FieldShell>
  );
}
