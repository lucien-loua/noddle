import { useCallback, useId } from "react";
import type { ReactNode } from "react";

import { useFieldContext } from "@/components/fields/lib/context";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export interface FieldRadioOption {
  description?: string;
  label: ReactNode;
  value: string;
}

export function FieldRadio({
  disabled,
  options,
}: {
  disabled?: boolean;
  options: FieldRadioOption[];
}) {
  const field = useFieldContext<string>();
  const id = useId();

  const handleChange = useCallback(
    (value: unknown) => {
      if (typeof value === "string") {
        field.handleChange(value);
      }
    },
    [field]
  );

  return (
    <RadioGroup
      disabled={disabled}
      onValueChange={handleChange}
      value={field.state.value}
    >
      {options.map((option) => {
        const optionId = `${id}-${option.value}`;
        return (
          <FieldLabel htmlFor={optionId} key={option.value}>
            <Field orientation="horizontal">
              <RadioGroupItem id={optionId} value={option.value} />
              <FieldContent>
                <FieldTitle>{option.label}</FieldTitle>
                {option.description ? (
                  <FieldDescription>{option.description}</FieldDescription>
                ) : null}
              </FieldContent>
            </Field>
          </FieldLabel>
        );
      })}
    </RadioGroup>
  );
}
