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

const NODDLE_VALIDATION_LOGIC = revalidateLogic({
  mode: "submit",
  modeAfterSubmission: "change",
});

export const useAppForm: typeof useBaseAppForm = (options) =>
  useBaseAppForm({ validationLogic: NODDLE_VALIDATION_LOGIC, ...options });
