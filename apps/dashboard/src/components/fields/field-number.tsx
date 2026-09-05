import type { ReactNode } from "react";
import { useCallback, useId } from "react";

import {
  FieldShell,
  fieldDescribedBy,
  fieldDisplayState,
} from "@/components/fields/field-shell";
import { useFieldContext } from "@/components/fields/lib/context";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";

interface NumberFieldProps {
  description?: string;
  disabled?: boolean;
  label: ReactNode;
  min?: number;
  placeholder?: string;
  required?: boolean;
  step?: number;
  unit?: ReactNode;
}

export function FieldNumber({
  description,
  disabled,
  label,
  min = 0,
  placeholder,
  required,
  step,
  unit,
}: NumberFieldProps) {
  const field = useFieldContext<number | null>();
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const { errors, invalid } = fieldDisplayState(field.state.meta);

  const handleChange = useCallback(
    (value: number | null) => field.handleChange(value),
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
      <NumberField
        disabled={disabled}
        id={id}
        min={min}
        onValueChange={handleChange}
        step={step}
        value={field.state.value}
      >
        <NumberFieldGroup
          aria-invalid={invalid || undefined}
          aria-required={required}
        >
          <NumberFieldDecrement />
          <NumberFieldInput
            aria-describedby={fieldDescribedBy({
              description,
              descriptionId,
              errorId,
              invalid,
            })}
            className={unit ? "pe-1.5 text-end" : undefined}
            name={field.name}
            onBlur={field.handleBlur}
            placeholder={placeholder}
          />
          {unit ? (
            <span className="select-none pe-2 text-muted-foreground text-sm">
              {unit}
            </span>
          ) : null}
          <NumberFieldIncrement />
        </NumberFieldGroup>
      </NumberField>
    </FieldShell>
  );
}
