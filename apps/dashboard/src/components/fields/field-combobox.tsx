import { Fragment, useCallback, useId, useMemo } from "react";
import type { ReactNode } from "react";

import {
  FieldShell,
  fieldDescribedBy,
  fieldDisplayState,
} from "@/components/fields/field-shell";
import { useFieldContext } from "@/components/fields/lib/context";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
} from "@/components/ui/combobox";

export interface FieldComboboxGroup<T> {
  items: T[];
  label: string;
}

function isComboboxGroup<T>(
  entry: T | FieldComboboxGroup<T>
): entry is FieldComboboxGroup<T> {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "items" in entry &&
    Array.isArray((entry as FieldComboboxGroup<T>).items)
  );
}

export function FieldCombobox<T>({
  description,
  emptyText,
  itemToId,
  items,
  itemToStringLabel,
  itemToStringValue,
  label,
  placeholder,
  renderItem,
  required,
}: {
  description?: string;
  emptyText: string;
  itemToId: (item: T) => string;
  items: (T | FieldComboboxGroup<T>)[];
  itemToStringLabel: (item: T) => string;
  itemToStringValue: (item: T) => string;
  label: ReactNode;
  placeholder?: string;
  renderItem: (item: T) => ReactNode;
  required?: boolean;
}) {
  const field = useFieldContext<string>();
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const { errors, invalid } = fieldDisplayState(field.state.meta);

  const flatItems = useMemo(
    () =>
      items.flatMap((entry) => (isComboboxGroup(entry) ? entry.items : entry)),
    [items]
  );

  const selected = useMemo(
    () =>
      flatItems.find((item) => itemToId(item) === field.state.value) ?? null,
    [flatItems, itemToId, field.state.value]
  );

  const handleChange = useCallback(
    (next: T | null) => {
      field.handleChange(next ? itemToId(next) : "");
    },
    [field, itemToId]
  );

  const renderComboboxItem = useCallback(
    (item: T) => (
      <ComboboxItem key={itemToId(item)} value={item}>
        {renderItem(item)}
      </ComboboxItem>
    ),
    [itemToId, renderItem]
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
      <Combobox
        items={items}
        itemToStringLabel={itemToStringLabel}
        itemToStringValue={itemToStringValue}
        onValueChange={handleChange}
        value={selected}
      >
        <ComboboxInput
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
          onBlur={field.handleBlur}
          placeholder={placeholder}
        />
        <ComboboxContent>
          <ComboboxEmpty>{emptyText}</ComboboxEmpty>
          <ComboboxList>
            {(entry: T | FieldComboboxGroup<T>, index) =>
              isComboboxGroup(entry) ? (
                <Fragment key={entry.label}>
                  <ComboboxGroup items={entry.items}>
                    <ComboboxLabel>{entry.label}</ComboboxLabel>
                    <ComboboxCollection>
                      {renderComboboxItem}
                    </ComboboxCollection>
                  </ComboboxGroup>
                  {index < items.length - 1 ? <ComboboxSeparator /> : null}
                </Fragment>
              ) : (
                renderComboboxItem(entry)
              )
            }
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </FieldShell>
  );
}
