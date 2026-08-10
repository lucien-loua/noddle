/** A failed teardown leaves the row stuck on `deleting` with no other
 *  clue: saying why here avoids having to go read the worker's logs. */
export function TeardownError({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <p className="-mt-2 mb-3 text-destructive text-sm" role="status">
      {message}
    </p>
  );
}
