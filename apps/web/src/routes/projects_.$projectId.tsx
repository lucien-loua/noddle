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
    // EXISTENCE is read from `projects`, NEVER from the dashboard's groups.
    //
    // Those are built from SERVICES: a project carrying none doesn't appear
    // there, and used to read as "unknown id". That was true as long as a
    // project could only be born from connecting a resource;
    // `createProject` made that assumption false, and a brand-new project
    // would render a 404 from the very screen that had just created it.
    //
    // The same flaw had been fixed on the environment route without being
    // fixed here: after finding a faulty pattern, you have to grep for it
    // before declaring it settled.
    const [projects, environments] = await Promise.all([
      getProjects(),
      getProjectEnvironments({ data: { projectId: params.projectId } }),
    ]);
    if (!projects.some((p) => p.id === params.projectId)) {
      throw notFound();
    }

    const [first] = environments;
    if (!first) {
      // Unreachable from the UI: `deleteEnvironment` refuses the default
      // environment a project is born with. Kept as a last resort for a
      // row removed out of band.
      throw notFound();
    }
    throw redirect({
      params: { environmentId: first.id, projectId: params.projectId },
      to: "/projects/$projectId/$environmentId",
    });
  },
});
