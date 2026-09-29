"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { CaretDownIcon, XIcon, CheckIcon } from "@phosphor-icons/react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

interface ComboboxAnchorStore {
  anchor: HTMLElement | null;
  setAnchor: (element: HTMLElement | null) => void;
}

const ComboboxAnchorContext = React.createContext<ComboboxAnchorStore | null>(
  null
);

const Combobox = <Value, Multiple extends boolean | undefined = false>({
  children,
  ...props
}: ComboboxPrimitive.Root.Props<Value, Multiple>) => {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const store = React.useMemo(() => ({ anchor, setAnchor }), [anchor]);
  return (
    <ComboboxAnchorContext.Provider value={store}>
      <ComboboxPrimitive.Root {...props}>{children}</ComboboxPrimitive.Root>
    </ComboboxAnchorContext.Provider>
  );
};

const ComboboxValue = ({ ...props }: ComboboxPrimitive.Value.Props) => (
  <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />
);

const ComboboxTrigger = ({
  className,
  children,
  ...props
}: ComboboxPrimitive.Trigger.Props) => (
  <ComboboxPrimitive.Trigger
    data-slot="combobox-trigger"
    className={cn("[&_svg:not([class*='size-'])]:size-4", className)}
    {...props}
  >
    {children}
    <CaretDownIcon
      className="pointer-events-none size-4 text-muted-foreground"
      weight="regular"
    />
  </ComboboxPrimitive.Trigger>
);

const ComboboxClear = ({
  className,
  ...props
}: ComboboxPrimitive.Clear.Props) => (
  <ComboboxPrimitive.Clear
    data-slot="combobox-clear"
    render={<InputGroupButton variant="ghost" size="icon-xs" />}
    className={cn(className)}
    {...props}
  >
    <XIcon className="pointer-events-none" weight="regular" />
  </ComboboxPrimitive.Clear>
);

const ComboboxInput = ({
  className,
  children,
  disabled = false,
  showTrigger = true,
  showClear = false,
  ...props
}: ComboboxPrimitive.Input.Props & {
  showTrigger?: boolean;
  showClear?: boolean;
}) => {
  const anchorStore = React.useContext(ComboboxAnchorContext);
  return (
    <InputGroup
      className={cn("w-auto", className)}
      ref={anchorStore?.setAnchor}
    >
      <ComboboxPrimitive.Input
        render={<InputGroupInput disabled={disabled} />}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        {showTrigger && (
          <InputGroupButton
            size="icon-xs"
            variant="ghost"
            render={<ComboboxTrigger />}
            data-slot="input-group-button"
            className="group-has-data-[slot=combobox-clear]/input-group:hidden data-pressed:bg-transparent"
            disabled={disabled}
          />
        )}
        {showClear && <ComboboxClear disabled={disabled} />}
      </InputGroupAddon>
      {children}
    </InputGroup>
  );
};

const ComboboxContent = ({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  alignOffset = 0,
  anchor,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "anchor"
  >) => {
  const anchorStore = React.useContext(ComboboxAnchorContext);
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor ?? anchorStore?.anchor ?? undefined}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          data-chips={!!anchor}
          className={cn(
            "dark group/combobox-content max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-3xl text-popover-foreground shadow-lg ring-1 ring-foreground/5 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 *:data-[slot=input-group]:m-1.5 *:data-[slot=input-group]:mb-0 *:data-[slot=input-group]:h-8 *:data-[slot=input-group]:border-input/30 *:data-[slot=input-group]:bg-input/50 *:data-[slot=input-group]:shadow-none dark:ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 animate-none! relative bg-popover/70 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150 **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[variant=destructive]:focus:bg-foreground/10! **:data-[variant=destructive]:text-accent-foreground! **:data-[variant=destructive]:**:text-accent-foreground!",
            className
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
};

const ComboboxList = ({
  className,
  ...props
}: ComboboxPrimitive.List.Props) => (
  <ComboboxPrimitive.List
    data-slot="combobox-list"
    className={cn(
      "no-scrollbar max-h-[min(calc(--spacing(72)-(--spacing(9))),calc(var(--available-height)-(--spacing(9))))] scroll-py-1.5 overflow-y-auto overscroll-contain p-1.5 data-empty:p-0",
      className
    )}
    {...props}
  />
);

const ComboboxItem = ({
  className,
  children,
  ...props
}: ComboboxPrimitive.Item.Props) => (
  <ComboboxPrimitive.Item
    data-slot="combobox-item"
    className={cn(
      "relative flex w-full cursor-default items-center gap-2.5 rounded-2xl py-2 pe-8 ps-1.75 text-sm font-medium outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      className
    )}
    {...props}
  >
    {children}
    <ComboboxPrimitive.ItemIndicator
      render={
        <span className="pointer-events-none absolute inset-e-1.75 flex size-4 items-center justify-center" />
      }
    >
      <CheckIcon className="pointer-events-none" weight="regular" />
    </ComboboxPrimitive.ItemIndicator>
  </ComboboxPrimitive.Item>
);

const ComboboxGroup = ({
  className,
  ...props
}: ComboboxPrimitive.Group.Props) => (
  <ComboboxPrimitive.Group
    data-slot="combobox-group"
    className={cn(className)}
    {...props}
  />
);

const ComboboxLabel = ({
  className,
  ...props
}: ComboboxPrimitive.GroupLabel.Props) => (
  <ComboboxPrimitive.GroupLabel
    data-slot="combobox-label"
    className={cn("px-1.75 py-2.5 text-xs text-muted-foreground", className)}
    {...props}
  />
);

const ComboboxCollection = ({
  ...props
}: ComboboxPrimitive.Collection.Props) => (
  <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />
);

const ComboboxEmpty = ({
  className,
  ...props
}: ComboboxPrimitive.Empty.Props) => (
  <ComboboxPrimitive.Empty
    data-slot="combobox-empty"
    className={cn(
      "hidden w-full justify-center py-2 text-center text-sm text-muted-foreground group-data-empty/combobox-content:flex",
      className
    )}
    {...props}
  />
);

const ComboboxSeparator = ({
  className,
  ...props
}: ComboboxPrimitive.Separator.Props) => (
  <ComboboxPrimitive.Separator
    data-slot="combobox-separator"
    className={cn("-mx-1.5 my-1.5 h-px bg-border", className)}
    {...props}
  />
);

const ComboboxChips = ({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof ComboboxPrimitive.Chips> &
  ComboboxPrimitive.Chips.Props) => (
  <ComboboxPrimitive.Chips
    data-slot="combobox-chips"
    className={cn(
      "flex min-h-9 flex-wrap items-center gap-1.5 rounded-3xl border border-transparent bg-input/50 bg-clip-padding px-3 py-1.5 text-sm transition-[color,box-shadow,background-color] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 has-aria-invalid:border-destructive has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20 has-data-[slot=combobox-chip]:px-1.5 dark:has-aria-invalid:border-destructive/50 dark:has-aria-invalid:ring-destructive/40",
      className
    )}
    {...props}
  />
);

const ComboboxChip = ({
  className,
  children,
  showRemove = true,
  ...props
}: ComboboxPrimitive.Chip.Props & {
  showRemove?: boolean;
}) => (
  <ComboboxPrimitive.Chip
    data-slot="combobox-chip"
    className={cn(
      "flex h-[calc(--spacing(5.5))] w-fit items-center justify-center gap-1 rounded-3xl bg-input px-2 text-xs font-medium whitespace-nowrap text-foreground has-disabled:pointer-events-none has-disabled:cursor-not-allowed has-disabled:opacity-50 has-data-[slot=combobox-chip-remove]:pe-0 dark:bg-input/60",
      className
    )}
    {...props}
  >
    {children}
    {showRemove && (
      <ComboboxPrimitive.ChipRemove
        render={<Button variant="ghost" size="icon-xs" />}
        className="-ms-1 opacity-50 hover:opacity-100"
        data-slot="combobox-chip-remove"
      >
        <XIcon className="pointer-events-none" weight="regular" />
      </ComboboxPrimitive.ChipRemove>
    )}
  </ComboboxPrimitive.Chip>
);

const ComboboxChipsInput = ({
  className,
  ...props
}: ComboboxPrimitive.Input.Props) => (
  <ComboboxPrimitive.Input
    data-slot="combobox-chip-input"
    className={cn("min-w-16 flex-1 outline-none", className)}
    {...props}
  />
);

function useComboboxAnchor() {
  return React.useRef<HTMLDivElement | null>(null);
}

export {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxSeparator,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxAnchor,
};
