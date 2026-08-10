import type { ReactNode } from "react";
import { useCallback, useId } from "react";
import { FieldShell, fieldDisplayState } from "@/components/fields/field-shell";
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
  /** Lower bound. Defaults to `0`, which replaces the "no negatives"
   *  check a text field had to do after the fact. */
  min?: number;
  placeholder?: string;
  /** Marks the label and sets `aria-required` on the field. */
  required?: boolean;
  step?: number;
  /** The unit shown to the right of the number. */
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
            aria-describedby={invalid ? errorId : undefined}
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
