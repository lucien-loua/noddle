import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { errorMessage } from "@/lib/format";

/**
 * One-click row delete with inline error. Confirm-name / FK disable stay
 * at the call site — this only owns pending + error + mutate.
 */
export function useRowRemove({
  errorFallback = "removal refused",
  mutationFn,
  onRemoved,
}: {
  errorFallback?: string;
  mutationFn: () => Promise<unknown>;
  onRemoved: () => void;
}): {
  error: string | null;
  handleRemove: () => void;
  isPending: boolean;
} {
  const [error, setError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn,
    onError: (e: Error) => setError(errorMessage(e, errorFallback)),
    onSuccess: onRemoved,
  });

  const handleRemove = useCallback(() => {
    setError(null);
    remove.mutate();
  }, [remove]);

  return {
    error,
    handleRemove,
    isPending: remove.isPending,
  };
}
