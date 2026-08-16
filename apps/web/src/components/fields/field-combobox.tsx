import { Fragment, useCallback, useId, useMemo } from "react";
import type { ReactNode } from "react";

import { FieldShell, fieldDisplayState } from "@/components/fields/field-shell";
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

/**
 * Generic combobox wired to the field — keys, servers, registries, S3
 * destinations: wherever "the list grows by the user's hand", see
 * `server-select.tsx`. The field holds a STRING (an id), never the object —
 * the same contract as `z.uuid()` on the server, so nothing to convert on
 * submit.
 *
 * What the field stores (`itemToId`) is deliberately distinct from what
 * search filters (`itemToStringValue`) and from what the input shows once
 * selected (`itemToStringLabel`) — conflating them already cost a field
 * filled with "name · 192.168.252.3" after selection (see
 * `server-select.tsx`).
 *
 * `items` accepts a flat list OR groups (`ComboboxGroup` + `ComboboxLabel`
 * + `ComboboxCollection`, separated by a `ComboboxSeparator`) — the exact
 * shape `Combobox` itself reads to filter by group, taken from
 * `ui.shadcn.com/docs/components/base/combobox` (composition
 * "With groups and collection").
 */
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
  /** Shown when no item matches the typed input. */
  emptyText: string;
  /** The identifier STORED in the field. */
  itemToId: (item: T) => string;
  items: (T | FieldComboboxGroup<T>)[];
  itemToStringLabel: (item: T) => string;
  itemToStringValue: (item: T) => string;
  label: ReactNode;
  placeholder?: string;
  /** Renders the CONTENT of an item — the wrapping `ComboboxItem` (its
   *  `key`, its `value`) is placed BY THIS COMPONENT, from `itemToId`. The
   *  caller only describes what is worth showing (name alone, name + host,
   *  name + engine…), never the Combobox wiring — otherwise every caller
   *  would import `ComboboxItem` for the same thing. */
  renderItem: (item: T) => ReactNode;
  required?: boolean;
}) {
  const field = useFieldContext<string>();
  const id = useId();
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
          aria-describedby={invalid ? errorId : undefined}
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
