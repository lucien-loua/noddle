import { useCallback, useId, useMemo } from "react";
import type { ReactNode } from "react";

import {
  FieldShell,
  fieldDescribedBy,
  fieldDisplayState,
} from "@/components/fields/field-shell";
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
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const { errors, invalid } = fieldDisplayState(field.state.meta);

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
      descriptionId={descriptionId}
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
          aria-describedby={fieldDescribedBy({
            description,
            descriptionId,
            errorId,
            invalid,
          })}
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
