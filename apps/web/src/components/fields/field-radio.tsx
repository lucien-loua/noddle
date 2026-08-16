import { useCallback, useId } from 'react';
import type { ReactNode } from 'react';

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
  /** A second line, muted, under the title: what the option commits to. */
  description?: string;
  label: ReactNode;
  value: string;
}

/**
 * A radio group where each option carries a title and, below it, what it
 * does — a choice is made knowing what it commits to.
 *
 * The label WRAPS the control: placed as a sibling, the accessibility tree
 * would announce TWO radios per option (the label's and the input's). Wired
 * to the field like all `Field*` components — the primitive holds the
 * state, not the form.
 */
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
