import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { getAuthState } from "@/server/auth";
import { getProjectEnvironments } from "@/server/environments";
import { getProjects } from "@/server/projects";

export const Route = createFileRoute("/projects_/$projectId")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
  },
  loader: async ({ params }) => {
    const [projects, environments] = await Promise.all([
      getProjects(),
      getProjectEnvironments({ data: { projectId: params.projectId } }),
    ]);
    if (!projects.some((p) => p.id === params.projectId)) {
      throw notFound();
    }

    const [first] = environments;
    if (!first) {
      throw notFound();
    }
    throw redirect({
      params: { environmentId: first.id, projectId: params.projectId },
      to: "/projects/$projectId/$environmentId",
    });
  },
});
