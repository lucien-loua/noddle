import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { errorMessage } from "@/lib/format";

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
