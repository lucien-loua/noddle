import {
  type GitSourceType,
  isGitSourceType,
  type ServiceDockerProviderInput,
  type ServiceGitProviderInput,
  serviceDockerProviderSchema,
  serviceGitProviderSchema,
} from "@noddle/shared/validation/service";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useAppForm } from "@/components/fields/lib/form";
import {
  DockerIcon,
  GitIcon,
  GithubIcon,
  GitlabIcon,
} from "@/components/features/services/provider-icons";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cache } from "@/lib/cache";
import { errorMessage } from "@/lib/format";
import type { ServiceRow } from "@/server/dashboard";
import { updateServiceSettings } from "@/server/services";

type ProviderTab = GitSourceType | "docker";

const GIT_URL_PLACEHOLDER: Record<GitSourceType, string> = {
  git: "https://git.example.com/org/repo.git",
  github: "https://github.com/org/repo.git",
  gitlab: "https://gitlab.com/org/repo.git",
};

function providerTab(sourceType: ServiceRow["sourceType"]): ProviderTab {
  if (sourceType === "docker_image") {
    return "docker";
  }
  if (isGitSourceType(sourceType)) {
    return sourceType;
  }
  return "git";
}

function isProviderTab(value: string): value is ProviderTab {
  return value === "docker" || isGitSourceType(value);
}

function GitSourceForm({
  canEdit,
  service,
  sourceType,
}: {
  canEdit: boolean;
  service: ServiceRow;
  sourceType: GitSourceType;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const save = useMutation({
    mutationFn: (value: ServiceGitProviderInput) =>
      updateServiceSettings({
        data: {
          buildMethod: service.buildMethod === "image" ? "nixpacks" : undefined,
          gitBranch: value.gitBranch,
          gitRepoUrl: value.gitRepoUrl,
          gitSubmodules: value.gitSubmodules,
          serviceId: service.id,
          sourceType,
        },
      }),
    onSuccess: async () => {
      await cache.service(queryClient, service.id);
      await router.invalidate();
    },
  });

  const defaultValues: ServiceGitProviderInput = {
    gitBranch: service.gitBranch ?? "main",
    gitRepoUrl: service.gitRepoUrl ?? "",
    gitSubmodules: service.gitSubmodules,
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: serviceGitProviderSchema },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: repo fields are the TRIGGER
  useEffect(() => {
    form.reset();
  }, [
    form.reset,
    service.gitBranch,
    service.gitRepoUrl,
    service.gitSubmodules,
  ]);

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  return (
    <>
      <FieldGroup>
        <form.AppField name="gitRepoUrl">
          {(f) => (
            <f.FieldText
              disabled={!canEdit}
              label="Repository URL"
              placeholder={GIT_URL_PLACEHOLDER[sourceType]}
            />
          )}
        </form.AppField>
        <form.AppField name="gitBranch">
          {(f) => (
            <f.FieldText
              disabled={!canEdit}
              label="Branch"
              placeholder="main"
              required
            />
          )}
        </form.AppField>
        <form.AppField name="gitSubmodules">
          {(f) => (
            <Field orientation="horizontal">
              <div className="flex flex-1 flex-col gap-1">
                <FieldLabel className="font-medium">Submodules</FieldLabel>
                <FieldDescription>
                  Clone submodules alongside the repository.
                </FieldDescription>
              </div>
              <Switch
                checked={f.state.value}
                disabled={!canEdit}
                onCheckedChange={f.handleChange}
              />
            </Field>
          )}
        </form.AppField>
      </FieldGroup>

      {save.isError ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {errorMessage(save.error, "could not save")}
        </p>
      ) : null}

      {canEdit ? (
        <div className="mt-4 flex justify-end">
          <Button
            disabled={save.isPending}
            onClick={handleSubmit}
            size="sm"
            variant="outline"
          >
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </div>
      ) : null}
    </>
  );
}

function DockerSourceForm({
  canEdit,
  service,
}: {
  canEdit: boolean;
  service: ServiceRow;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const save = useMutation({
    mutationFn: (value: ServiceDockerProviderInput) =>
      updateServiceSettings({
        data: {
          buildMethod: "image",
          dockerImage: value.dockerImage,
          serviceId: service.id,
          sourceType: "docker_image",
        },
      }),
    onSuccess: async () => {
      await cache.service(queryClient, service.id);
      await router.invalidate();
    },
  });

  const defaultValues: ServiceDockerProviderInput = {
    dockerImage: service.dockerImage ?? "",
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: serviceDockerProviderSchema },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: image field is the TRIGGER
  useEffect(() => {
    form.reset();
  }, [form.reset, service.dockerImage]);

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  return (
    <>
      <FieldGroup>
        <form.AppField name="dockerImage">
          {(f) => (
            <f.FieldText
              description="Image Swarm pulls on the next Deploy, for example nginx:alpine. A private registry is chosen under Advanced."
              disabled={!canEdit}
              label="Docker image"
              placeholder="nginx:alpine"
            />
          )}
        </form.AppField>
      </FieldGroup>

      {save.isError ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {errorMessage(save.error, "could not save")}
        </p>
      ) : null}

      {canEdit ? (
        <div className="mt-4 flex justify-end">
          <Button
            disabled={save.isPending}
            onClick={handleSubmit}
            size="sm"
            variant="outline"
          >
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function ServiceProvider({
  canEdit,
  service,
}: {
  canEdit: boolean;
  service: ServiceRow;
}) {
  const [tab, setTab] = useState<ProviderTab>(() =>
    providerTab(service.sourceType)
  );

  useEffect(() => {
    setTab(providerTab(service.sourceType));
  }, [service.sourceType]);

  const handleTabChange = useCallback((value: unknown) => {
    if (typeof value === "string" && isProviderTab(value)) {
      setTab(value);
    }
  }, []);

  return (
    <Frame variant="ghost">
      <FrameHeader>
        <FrameTitle>Provider</FrameTitle>
        <FrameDescription>Select the source of your code</FrameDescription>
      </FrameHeader>
      <FramePanel>
        <Tabs className="gap-4" onValueChange={handleTabChange} value={tab}>
          <TabsList>
            <TabsTrigger value="github">
              <GithubIcon />
              GitHub
            </TabsTrigger>
            <TabsTrigger value="gitlab">
              <GitlabIcon />
              GitLab
            </TabsTrigger>
            <TabsTrigger value="git">
              <GitIcon />
              Git
            </TabsTrigger>
            <TabsTrigger value="docker">
              <DockerIcon />
              Docker
            </TabsTrigger>
          </TabsList>

          <TabsContent value="github">
            <GitSourceForm
              canEdit={canEdit}
              service={service}
              sourceType="github"
            />
          </TabsContent>
          <TabsContent value="gitlab">
            <GitSourceForm
              canEdit={canEdit}
              service={service}
              sourceType="gitlab"
            />
          </TabsContent>
          <TabsContent value="git">
            <GitSourceForm
              canEdit={canEdit}
              service={service}
              sourceType="git"
            />
          </TabsContent>
          <TabsContent value="docker">
            <DockerSourceForm canEdit={canEdit} service={service} />
          </TabsContent>
        </Tabs>
      </FramePanel>
    </Frame>
  );
}
