export function assertNotDefaultEnvironment(
  environment: { isDefault: boolean },
  action: "delete" | "rename"
): void {
  if (!environment.isDefault) {
    return;
  }
  throw new Error(
    action === "delete"
      ? "you cannot delete the default environment"
      : "you cannot rename the default environment"
  );
}
