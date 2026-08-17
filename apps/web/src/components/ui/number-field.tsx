"use client";

import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { MinusIcon, PlusIcon } from "@phosphor-icons/react";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import type { ReactNode } from "react";
import { createContext, useContext, useId } from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const NumberFieldContext = createContext<{
  fieldId: string;
  size: "sm" | "default" | "lg";
} | null>(null);

const numberFieldGroupVariants = cva(
  "relative flex w-full items-center justify-between rounded-4xl border border-transparent bg-input/50 text-sm outline-none transition-[color,box-shadow,background-color] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 dark:aria-invalid:ring-destructive/40",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        default: "h-9",
        lg: "h-10",
        sm: "h-8",
      },
    },
  },
);

const numberFieldButtonVariants = cva(
  "relative flex shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        default: "px-3 [&_svg:not([class*='size-'])]:size-4",
        lg: "px-3.5 [&_svg:not([class*='size-'])]:size-4",
        sm: "px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
  },
);

const numberFieldInputVariants = cva(
  "w-full min-w-0 flex-1 bg-transparent text-center tabular-nums outline-none placeholder:text-muted-foreground",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        default: "px-2.5 py-1",
        lg: "px-2.5 py-1.5",
        sm: "px-2 py-0.5",
      },
    },
  },
);

function NumberField({
  id,
  className,
  size = "default",
  ...props
}: NumberFieldPrimitive.Root.Props & VariantProps<typeof numberFieldGroupVariants>) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const sizeValue = size ?? "default";

  return (
    <NumberFieldContext.Provider value={{ fieldId, size: sizeValue }}>
      <NumberFieldPrimitive.Root
        className={cn("flex w-full flex-col items-start gap-2", className)}
        data-size={sizeValue}
        data-slot="number-field"
        id={fieldId}
        // The primitive's default is the RUNTIME locale: on a machine set to
        // French, `0.5` displayed as "0,5". The visible text is in English,
        // and a render locale that follows the machine is also the
        // server/client mismatch that rejects the tree at hydration. Overridable.
        locale="en-US"
        // The primitive's second default: thousands separators. Correct
        // for a quantity, wrong for a port or an identifier — `3000`
        // displayed as "3,000". Both are overridable via `format`.
        format={{ useGrouping: false }}
        {...props}
      />
    </NumberFieldContext.Provider>
  );
}

function NumberFieldGroup({
  className,
  size: sizeProp,
  ...props
}: NumberFieldPrimitive.Group.Props & Partial<VariantProps<typeof numberFieldGroupVariants>>) {
  const context = useContext(NumberFieldContext);
  if (!context) {
    throw new Error("NumberFieldGroup must be used within a NumberField component.");
  }
  const size = sizeProp ?? context.size;

  return (
    <NumberFieldPrimitive.Group
      className={cn(numberFieldGroupVariants({ size }), className)}
      data-slot="number-field-group"
      {...props}
    />
  );
}

function NumberFieldDecrement({
  className,
  size: sizeProp,
  children,
  ...props
}: NumberFieldPrimitive.Decrement.Props &
  Partial<VariantProps<typeof numberFieldButtonVariants>> & {
    children?: React.ReactNode;
  }) {
  const context = useContext(NumberFieldContext);
  if (!context) {
    throw new Error("NumberFieldDecrement must be used within a NumberField component.");
  }
  const size = sizeProp ?? context.size;

  return (
    <NumberFieldPrimitive.Decrement
      className={cn(numberFieldButtonVariants({ size }), "rounded-s-4xl", className)}
      data-slot="number-field-decrement"
      {...props}
    >
      {children ?? <MinusIcon weight="regular" />}
    </NumberFieldPrimitive.Decrement>
  );
}

function NumberFieldIncrement({
  className,
  size: sizeProp,
  children,
  ...props
}: NumberFieldPrimitive.Increment.Props &
  Partial<VariantProps<typeof numberFieldButtonVariants>> & {
    children?: ReactNode;
  }) {
  const context = useContext(NumberFieldContext);
  if (!context) {
    throw new Error("NumberFieldIncrement must be used within a NumberField component.");
  }
  const size = sizeProp ?? context.size;

  return (
    <NumberFieldPrimitive.Increment
      className={cn(numberFieldButtonVariants({ size }), "rounded-e-4xl", className)}
      data-slot="number-field-increment"
      {...props}
    >
      {children ?? <PlusIcon weight="regular" />}
    </NumberFieldPrimitive.Increment>
  );
}

function NumberFieldInput({
  className,
  size: sizeProp,
  ...props
}: NumberFieldPrimitive.Input.Props & Partial<VariantProps<typeof numberFieldInputVariants>>) {
  const context = useContext(NumberFieldContext);
  if (!context) {
    throw new Error("NumberFieldInput must be used within a NumberField component.");
  }
  const size = sizeProp ?? context.size;

  return (
    <NumberFieldPrimitive.Input
      className={cn(numberFieldInputVariants({ size }), className)}
      data-slot="number-field-input"
      {...props}
    />
  );
}

function NumberFieldScrubArea({
  className,
  label,
  ...props
}: NumberFieldPrimitive.ScrubArea.Props & {
  label: string;
}) {
  const context = useContext(NumberFieldContext);
  if (!context) {
    throw new Error(
      "NumberFieldScrubArea must be used within a NumberField component for accessibility.",
    );
  }

  return (
    <NumberFieldPrimitive.ScrubArea
      className={cn("flex cursor-ew-resize", className)}
      data-slot="number-field-scrub-area"
      {...props}
    >
      <Label className="cursor-ew-resize" htmlFor={context.fieldId}>
        {label}
      </Label>
      <NumberFieldPrimitive.ScrubAreaCursor className="drop-shadow-[0_1px_1px_#0008] filter">
        <CursorGrowIcon />
      </NumberFieldPrimitive.ScrubAreaCursor>
    </NumberFieldPrimitive.ScrubArea>
  );
}

function CursorGrowIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg
      fill="black"
      height="14"
      stroke="white"
      viewBox="0 0 24 14"
      width="26"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      aria-hidden="true"
    >
      <path d="M19.5 5.5L6.49737 5.51844V2L1 6.9999L6.5 12L6.49737 8.5L19.5 8.5V12L25 6.9999L19.5 2V5.5Z" />
    </svg>
  );
}

export {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
  NumberFieldScrubArea,
};
