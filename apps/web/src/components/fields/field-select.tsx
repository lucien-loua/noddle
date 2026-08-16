import { useCallback, useId, useMemo } from 'react';
import type { ReactNode } from 'react';

import { FieldShell, fieldDisplayState } from "@/components/fields/field-shell";
import { useFieldContext } from "@/components/fields/lib/context";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface FieldSelectOption {
  /** A second line, muted, BELOW the label in the menu — what an option
   *  GRANTS (a role) or what it's for (an algorithm). The trigger itself
   *  only shows `label`: the description would weigh down a line that
   *  needs to be readable at a glance. */
  description?: string;
  label: ReactNode;
  value: string;
}

export function FieldSelect({
  description,
  disabled,
  label,
  options,
  placeholder,
  required,
}: {
  description?: string;
  disabled?: boolean;
  label: ReactNode;
  options: FieldSelectOption[];
  placeholder?: string;
  required?: boolean;
}) {
  const field = useFieldContext<string>();
  const id = useId();
  const errorId = `${id}-error`;
  const { errors, invalid } = fieldDisplayState(field.state.meta);

  // `items` maps value → `label` ONLY: that's what the trigger displays via
  // `SelectValue`. The description only lives in the menu.
  const items = useMemo(
    () => Object.fromEntries(options.map((o) => [o.value, o.label])),
    [options]
  );

  const handleChange = useCallback(
    (value: string | null) => field.handleChange(value ?? ""),
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
      <Select
        disabled={disabled}
        items={items}
        onValueChange={handleChange}
        value={field.state.value}
      >
        <SelectTrigger
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid}
          aria-required={required}
          className="w-full"
          id={id}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.description ? (
                  <span className="flex flex-col gap-0.5 whitespace-normal">
                    <span>{option.label}</span>
                    <span className="font-normal text-muted-foreground text-xs">
                      {option.description}
                    </span>
                  </span>
                ) : (
                  option.label
                )}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </FieldShell>
  );
}
