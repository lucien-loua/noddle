import { createFormHook, revalidateLogic } from "@tanstack/react-form";
import { FieldCombobox } from "@/components/fields/field-combobox";
import { FieldNumber } from "@/components/fields/field-number";
import { FieldPassword } from "@/components/fields/field-password";
import { FieldRadio } from "@/components/fields/field-radio";
import { FieldSelect } from "@/components/fields/field-select";
import { FieldText } from "@/components/fields/field-text";
import { FieldTextarea } from "@/components/fields/field-textarea";
import { fieldContext, formContext } from "@/components/fields/lib/context";

const { useAppForm: useBaseAppForm, withForm } = createFormHook({
  fieldComponents: {
    FieldCombobox,
    FieldNumber,
    FieldPassword,
    FieldRadio,
    FieldSelect,
    FieldText,
    FieldTextarea,
  },
  fieldContext,
  formComponents: {},
  formContext,
});

export { withForm };

/**
 * Silent until the first submission, reactive afterward.
 *
 * Without this, a field only revalidates on the NEXT submit: you fix a
 * rejected URL, the message disappears — and if you make the same mistake
 * again, the screen says nothing until you click "Save" again. The form
 * then looks valid when it isn't, which is exactly the screen lie this
 * product forbids.
 *
 * The opposite — validating on the very first keystroke — blames an empty
 * field on someone who simply hasn't finished filling it in. `mode:
 * "submit"` followed by `modeAfterSubmission: "change"` is the compromise
 * TanStack provides for exactly this case, and it lives HERE rather than at
 * every call site: a form that forgot it would behave differently from all
 * the others.
 *
 * Consequence for callers: the schema is placed on `onDynamic`, not on
 * `onSubmit` — `onDynamic` is called ONLY if a `validationLogic` is
 * provided, and it's the one that carries both phases.
 */
const NODDLE_VALIDATION_LOGIC = revalidateLogic({
  mode: "submit",
  modeAfterSubmission: "change",
});

/**
 * `useAppForm` with the revalidation logic already set.
 *
 * The type is taken as-is from the generated version: the wrapper only adds
 * a default, it must not take anything away from the inference of values or
 * fields. A caller who needs different logic can still pass it — it gets
 * overridden by the spread.
 */
export const useAppForm: typeof useBaseAppForm = (options) =>
  useBaseAppForm({ validationLogic: NODDLE_VALIDATION_LOGIC, ...options });
