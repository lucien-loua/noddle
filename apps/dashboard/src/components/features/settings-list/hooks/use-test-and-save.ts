import { useMutation } from "@tanstack/react-query";

import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";

interface ToastCopy {
  description?: string;
  title: string;
}

interface ErrorCopy {
  fallback: string;
  title: string;
}

export function useTestAndSave<TValues, TTestResult = unknown>({
  interpretTestResult,
  onSaved,
  saveError,
  saveFn,
  saveSuccess,
  testError,
  testFn,
  testSuccess,
}: {
  interpretTestResult?: (result: TTestResult) => string | null;
  onSaved: () => void | Promise<void>;
  saveError: ErrorCopy;
  saveFn: (values: TValues) => Promise<unknown>;
  saveSuccess: (values: TValues) => ToastCopy;
  testError: ErrorCopy;
  testFn: (values: TValues) => Promise<TTestResult>;
  testSuccess: (values: TValues) => ToastCopy;
}): {
  busy: boolean;
  runSave: (values: TValues) => Promise<unknown>;
  runTest: (values: TValues) => Promise<TTestResult>;
  savePending: boolean;
  testPending: boolean;
} {
  const test = useMutation({
    mutationFn: testFn,
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, testError.fallback),
        title: testError.title,
        type: "error",
      }),
    onSuccess: (result, values) => {
      const soft = interpretTestResult?.(result) ?? null;
      if (soft) {
        toast.add({
          description: soft,
          title: testError.title,
          type: "error",
        });
        return;
      }
      toast.add({ ...testSuccess(values), type: "success" });
    },
  });

  const save = useMutation({
    mutationFn: saveFn,
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, saveError.fallback),
        title: saveError.title,
        type: "error",
      }),
    onSuccess: async (_result, values) => {
      toast.add({ ...saveSuccess(values), type: "success" });
      await onSaved();
    },
  });

  return {
    busy: test.isPending || save.isPending,
    runSave: (values: TValues) => save.mutateAsync(values),
    runTest: (values: TValues) => test.mutateAsync(values),
    savePending: save.isPending,
    testPending: test.isPending,
  };
}
