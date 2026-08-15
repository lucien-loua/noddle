import {
  type GitSourceType,
  isGitSourceType,
  type ServiceDockerProviderInput,
  type ServiceGitProviderInput,
  serviceDockerProviderSchema,
  serviceGitProviderSchema,
} from "@noddle/shared/validation/service";
import { XIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  DockerIcon,
  GithubIcon,
  GitIcon,
  GitlabIcon,
} from "@/components/features/services/provider-icons";
import { useAppForm } from "@/components/fields/lib/form";
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cache } from "@/lib/cache";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
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

function WatchPathRow({
  onRemove,
  path,
}: {
  onRemove: (path: string) => void;
  path: string;
}) {
  const handleRemove = useCallback(() => onRemove(path), [onRemove, path]);

  return (
    <Item role="listitem" size="xs" variant="outline">
      <ItemContent>
        <ItemTitle className="truncate font-mono">{path}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <Button
          aria-label={`Remove ${path}`}
          onClick={handleRemove}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * A push deploys when it touches one of these globs. Empty means every push
 * deploys — stated in the description, because an empty list that silently
 * blocked deploys would be the worst reading of the same screen.
 */
function WatchPathsField({
  canEdit,
  onChange,
  value,
}: {
  canEdit: boolean;
  onChange: (next: string[]) => void;
  value: string[];
}) {
  const [draft, setDraft] = useState("");

  const add = useCallback(() => {
    const path = draft.trim();
    setDraft("");
    if (path !== "" && !value.includes(path)) {
      onChange([...value, path]);
    }
  }, [draft, onChange, value]);

  const remove = useCallback(
    (path: string) => onChange(value.filter((p) => p !== path)),
    [onChange, value]
  );

  const handleDraft = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    []
  );

  // Enter adds the path instead of submitting the form: the field sits in
  // the middle of one, and losing a typed path to a save is worse.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        add();
      }
    },
    [add]
  );

  return (
    <Field>
      <FieldLabel htmlFor="watch-path-draft">Watch paths</FieldLabel>
      <FieldDescription>
        Deploy only when a push touches one of these globs, for example
        apps/web/**. Empty deploys on every push.
      </FieldDescription>
      <InputGroup>
        <InputGroupInput
          disabled={!canEdit}
          id="watch-path-draft"
          onChange={handleDraft}
          onKeyDown={handleKeyDown}
          placeholder="apps/web/**"
          value={draft}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            disabled={!canEdit || draft.trim() === ""}
            onClick={add}
            variant="outline"
          >
            Add
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {value.length > 0 ? (
        <ItemGroup>
          {value.map((path) => (
            <WatchPathRow key={path} onRemove={remove} path={path} />
          ))}
        </ItemGroup>
      ) : null}
    </Field>
  );
}

/** What `null` means in the selector: a value, not an absence. */
const NO_DEPLOY_KEY = "none";

/**
 * Which key clones a PRIVATE repository. Loaded from the client and only
 * when editing is allowed: in the route loader it would fail the whole page
 * for a role without the permission.
 */
function DeployKeyField({
  canEdit,
  onChange,
  value,
}: {
  canEdit: boolean;
  onChange: (next: string | null) => void;
  value: string | null;
}) {
  const keys = useQuery({ ...queries.sshKeys(), enabled: canEdit });

  const handleChange = useCallback(
    (next: unknown) => {
      if (typeof next === "string") {
        onChange(next === NO_DEPLOY_KEY ? null : next);
      }
    },
    [onChange]
  );

  const rows = keys.data ?? [];

  return (
    <Field>
      <FieldLabel htmlFor="deploy-key">Deploy key</FieldLabel>
      <FieldDescription>
        SSH key used to clone a private repository. Add its public half as a
        deploy key on the repository.
      </FieldDescription>
      <Select
        disabled={!canEdit}
        items={[
          { label: "None", value: NO_DEPLOY_KEY },
          ...rows.map((k) => ({ label: k.name, value: k.id })),
        ]}
        onValueChange={handleChange}
        value={value ?? NO_DEPLOY_KEY}
      >
        <SelectTrigger aria-label="Deploy key" id="deploy-key">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_DEPLOY_KEY}>None</SelectItem>
          {rows.map((k) => (
            <SelectItem key={k.id} value={k.id}>
              {k.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
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
          buildPath: value.buildPath,
          deployKeyId: value.deployKeyId,
          gitBranch: value.gitBranch,
          gitRepoUrl: value.gitRepoUrl,
          gitSubmodules: value.gitSubmodules,
          serviceId: service.id,
          sourceType,
          watchPaths: value.watchPaths,
        },
      }),
    onSuccess: async () => {
      await cache.service(queryClient, service.id);
      await router.invalidate();
    },
  });

  const defaultValues: ServiceGitProviderInput = {
    buildPath: service.buildPath ?? "",
    deployKeyId: service.deployKeyId,
    gitBranch: service.gitBranch ?? "main",
    gitRepoUrl: service.gitRepoUrl ?? "",
    gitSubmodules: service.gitSubmodules,
    watchPaths: service.watchPaths,
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
    service.buildPath,
    service.deployKeyId,
    service.gitBranch,
    service.gitRepoUrl,
    service.gitSubmodules,
    service.watchPaths,
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
        <form.AppField name="buildPath">
          {(f) => (
            <f.FieldText
              description="Directory inside the repository to build, for a monorepo. Empty builds the root."
              disabled={!canEdit}
              label="Build path"
              placeholder="apps/web"
            />
          )}
        </form.AppField>
        <form.AppField name="deployKeyId">
          {(f) => (
            <DeployKeyField
              canEdit={canEdit}
              onChange={f.handleChange}
              value={f.state.value}
            />
          )}
        </form.AppField>
        <form.AppField name="watchPaths">
          {(f) => (
            <WatchPathsField
              canEdit={canEdit}
              onChange={f.handleChange}
              value={f.state.value}
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
