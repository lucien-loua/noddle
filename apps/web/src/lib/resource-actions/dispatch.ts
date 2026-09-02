import type { Action, Target } from "@/lib/resource-actions/core";
import { deleteDatabase, triggerDatabaseLifecycle } from "@/server/databases";
import { triggerDeploy, triggerLifecycle } from "@/server/deployments";
import { deleteService } from "@/server/services";
import { deleteStack, triggerStackDeploy } from "@/server/stacks";

export interface DispatchOptions {
  confirmName?: string;
}

export async function dispatch(
  target: Target,
  action: Action,
  opts?: DispatchOptions
): Promise<unknown> {
  if (action === "delete") {
    const confirmName = opts?.confirmName ?? "";
    if (target.kind === "service") {
      return await deleteService({
        data: { confirmName, serviceId: target.id },
      });
    }
    if (target.kind === "stack") {
      return await deleteStack({
        data: { confirmName, stackId: target.id },
      });
    }
    return await deleteDatabase({
      data: { confirmName, databaseId: target.id },
    });
  }

  if (action === "deploy") {
    return target.kind === "stack"
      ? await triggerStackDeploy({ data: { stackId: target.id } })
      : await triggerDeploy({ data: { serviceId: target.id } });
  }

  return target.kind === "database"
    ? await triggerDatabaseLifecycle({
        data: { action, databaseId: target.id },
      })
    : await triggerLifecycle({ data: { action, serviceId: target.id } });
}
