import { dockerSourcePatch, gitSourcePatch } from "@noddle/shared/source-type";
import {
  BUILT_IN_REGISTRY,
  isGitSourceType,
  NEW_REGISTRY,
  serviceDockerProviderSchema,
  serviceGitProviderSchema,
} from "@noddle/shared/validation/service";
import type {
  GitSourceType,
  ServiceDockerProviderInput,
  ServiceGitProviderInput,
} from "@noddle/shared/validation/service";
import { XIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import type { SubmitEvent } from "react";
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
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
  SelectGroup,
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
import { saveRegistry, setServiceRegistry } from "@/server/registries";
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

function selectRegistryChoice(state: {
  values: { registryChoice: string };
}): string {
  return state.values.registryChoice;
}

function selectRepoAndBranch(state: {
  values: { gitBranch: string; gitRepoUrl: string };
}) {
  return {
    branch: state.values.gitBranch,
    repoUrl: state.values.gitRepoUrl,
  };
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
          <XIcon weight="regular" />
        </Button>
      </ItemActions>
    </Item>
  );
}

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

const NO_DEPLOY_KEY = "none";

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
          <SelectGroup>
            <SelectItem value={NO_DEPLOY_KEY}>None</SelectItem>
            {rows.map((k) => (
              <SelectItem key={k.id} value={k.id}>
                {k.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

interface ProviderRepo {
  defaultBranch: string;
  fullName: string;
  url: string;
}

const repoLabel = (repo: ProviderRepo) => repo.fullName;

function ProviderBranchField({
  branch,
  canEdit,
  fullName,
  onChange,
  providerId,
}: {
  branch: string;
  canEdit: boolean;
  fullName: string;
  onChange: (next: string) => void;
  providerId: string;
}) {
  const branches = useQuery({
    ...queries.providerBranches(providerId, fullName),
    enabled: canEdit,
  });

  const handleChange = useCallback(
    (next: string | null) => {
      if (next) {
        onChange(next);
      }
    },
    [onChange]
  );

  return (
    <Field>
      <FieldLabel htmlFor="git-branch-pick">Branch</FieldLabel>
      {branches.isError ? (
        <FieldDescription className="text-destructive">
          {errorMessage(branches.error, "could not list branches")}
        </FieldDescription>
      ) : null}
      <Combobox
        items={branches.data ?? []}
        onValueChange={handleChange}
        value={branch}
      >
        <ComboboxInput
          className="w-full"
          disabled={!canEdit || branches.isPending}
          id="git-branch-pick"
          placeholder={branches.isPending ? "Loading…" : "Search a branch"}
        />
        <ComboboxContent>
          <ComboboxEmpty>No branch matches.</ComboboxEmpty>
          <ComboboxList>
            {(name: string) => (
              <ComboboxItem key={name} value={name}>
                {name}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </Field>
  );
}

function ProviderRepositoryField({
  branch,
  canEdit,
  forge,
  onBranchChange,
  onPick,
  onProviderChange,
  providerId,
  repoUrl,
}: {
  branch: string;
  canEdit: boolean;
  forge: "github" | "gitlab";
  onBranchChange: (next: string) => void;
  onPick: (repo: ProviderRepo) => void;
  onProviderChange: (next: string) => void;
  providerId: string | null;
  repoUrl: string;
}) {
  const providers = useQuery({ ...queries.gitProviders(), enabled: canEdit });

  const connected = (providers.data ?? []).filter(
    (p) => p.connected && p.providerType === forge
  );

  const selected = connected.some((p) => p.id === providerId)
    ? providerId
    : null;

  const repos = useQuery({
    ...queries.providerRepositories(selected ?? ""),
    enabled: canEdit && selected !== null,
  });

  const handleProvider = useCallback(
    (next: unknown) => {
      if (typeof next === "string" && next !== "") {
        onProviderChange(next);
      }
    },
    [onProviderChange]
  );

  const rows = repos.data ?? [];
  const selectedRepo = rows.find((r) => r.url === repoUrl) ?? null;

  const handleRepo = useCallback(
    (next: ProviderRepo | null) => {
      if (next) {
        onPick(next);
      }
    },
    [onPick]
  );

  return (
    <>
      <Field>
        <FieldLabel htmlFor="git-provider">Connection</FieldLabel>
        <FieldDescription>
          Which connected account clones this repository. To clone a public
          repository by URL instead, use the Git tab.
        </FieldDescription>
        <Select
          disabled={!canEdit}
          items={connected.map((p) => ({ label: p.name, value: p.id }))}
          onValueChange={handleProvider}
          value={selected}
        >
          <SelectTrigger aria-label="Connection" id="git-provider">
            <SelectValue placeholder="Choose a connection" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {connected.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="flex items-center gap-2">
                    {p.providerType === "gitlab" ? (
                      <GitlabIcon />
                    ) : (
                      <GithubIcon />
                    )}
                    {p.name}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      {selected ? (
        <Field>
          <FieldLabel htmlFor="git-repository">Repository</FieldLabel>
          {repos.isError ? (
            <FieldDescription className="text-destructive">
              {errorMessage(repos.error, "could not list repositories")}
            </FieldDescription>
          ) : null}
          <Combobox
            items={rows}
            itemToStringLabel={repoLabel}
            itemToStringValue={repoLabel}
            onValueChange={handleRepo}
            value={selectedRepo}
          >
            <ComboboxInput
              className="w-full"
              disabled={!canEdit || repos.isPending}
              id="git-repository"
              placeholder={repos.isPending ? "Loading…" : "Search a repository"}
            />
            <ComboboxContent>
              <ComboboxEmpty>No repository matches.</ComboboxEmpty>
              <ComboboxList>
                {(repo: ProviderRepo) => (
                  <ComboboxItem key={repo.url} value={repo}>
                    {repo.fullName}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </Field>
      ) : null}

      {selected && selectedRepo ? (
        <ProviderBranchField
          branch={branch}
          canEdit={canEdit}
          fullName={selectedRepo.fullName}
          onChange={onBranchChange}
          providerId={selected}
        />
      ) : null}
    </>
  );
}

function HookWarning({ error }: { error: string }) {
  return (
    <Field>
      <FieldDescription className="text-destructive">
        Autodeploy is not armed for this repository: {error}
      </FieldDescription>
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
          ...gitSourcePatch(sourceType, value, service),
          serviceId: service.id,
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
    gitProviderId: service.gitProviderId,
    gitRepoFullName: service.gitRepoFullName,
    gitRepoUrl: service.gitRepoUrl ?? "",
    gitSubmodules: service.gitSubmodules,
    watchPaths: service.watchPaths,
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: serviceGitProviderSchema },
  });

  useEffect(() => {
    form.reset();
  }, [
    form.reset,
    service.buildPath,
    service.deployKeyId,
    service.gitBranch,
    service.gitProviderId,
    service.gitRepoFullName,
    service.gitRepoUrl,
    service.gitSubmodules,
    service.watchPaths,
  ]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  const handlePick = useCallback(
    (repo: ProviderRepo) => {
      form.setFieldValue("gitRepoUrl", repo.url);
      form.setFieldValue("gitRepoFullName", repo.fullName);
      form.setFieldValue("gitBranch", repo.defaultBranch);
    },
    [form]
  );

  const handleBranchPick = useCallback(
    (next: string) => form.setFieldValue("gitBranch", next),
    [form]
  );

  return (
    <form noValidate onSubmit={handleSubmit}>
      <FieldGroup>
        {sourceType === "git" ? null : (
          <form.Subscribe selector={selectRepoAndBranch}>
            {({ branch, repoUrl }) => (
              <form.AppField name="gitProviderId">
                {(f) => (
                  <ProviderRepositoryField
                    branch={branch}
                    canEdit={canEdit}
                    forge={sourceType === "gitlab" ? "gitlab" : "github"}
                    onBranchChange={handleBranchPick}
                    onPick={handlePick}
                    onProviderChange={f.handleChange}
                    providerId={f.state.value}
                    repoUrl={repoUrl}
                  />
                )}
              </form.AppField>
            )}
          </form.Subscribe>
        )}
        {service.hookError ? <HookWarning error={service.hookError} /> : null}
        {sourceType === "git" ? (
          <>
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
          </>
        ) : null}
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
        {sourceType === "git" ? (
          <form.AppField name="deployKeyId">
            {(f) => (
              <DeployKeyField
                canEdit={canEdit}
                onChange={f.handleChange}
                value={f.state.value}
              />
            )}
          </form.AppField>
        ) : null}
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
            type="submit"
            size="sm"
            variant="outline"
          >
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </div>
      ) : null}
    </form>
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

  const registries = useQuery({
    ...queries.registryOptions(),
    enabled: canEdit,
  });

  const save = useMutation({
    mutationFn: async (value: ServiceDockerProviderInput) => {
      let registryId: string | null = null;
      if (value.registryChoice === NEW_REGISTRY) {
        const created = await saveRegistry({
          data: {
            imagePrefix: "",
            name: value.registryName,
            password: value.registryPassword,
            registryUrl: value.registryUrl,
            username: value.registryUsername,
          },
        });
        registryId = created.id;
      } else if (value.registryChoice !== BUILT_IN_REGISTRY) {
        registryId = value.registryChoice;
      }

      await updateServiceSettings({
        data: {
          ...dockerSourcePatch(value.dockerImage),
          serviceId: service.id,
        },
      });
      await setServiceRegistry({
        data: { registryId, serviceId: service.id },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["registry-options"] });
      await cache.service(queryClient, service.id);
      await router.invalidate();
    },
  });

  const defaultValues: ServiceDockerProviderInput = {
    dockerImage: service.dockerImage ?? "",
    registryChoice: service.registryId ?? BUILT_IN_REGISTRY,
    registryName: "",
    registryPassword: "",
    registryUrl: "",
    registryUsername: "",
  };

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => save.mutateAsync(value),
    validators: { onDynamic: serviceDockerProviderSchema },
  });

  useEffect(() => {
    form.reset();
  }, [form.reset, service.dockerImage]);

  const handleSubmit = useCallback(
    (event: SubmitEvent) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  const registryItems = [
    { label: "Built-in registry", value: BUILT_IN_REGISTRY },
    ...(registries.data ?? []).map((r) => ({ label: r.name, value: r.id })),
    { label: "Add a registry…", value: NEW_REGISTRY },
  ];

  return (
    <form noValidate onSubmit={handleSubmit}>
      <FieldGroup>
        <form.AppField name="dockerImage">
          {(f) => (
            <f.FieldText
              description="Image Swarm pulls on the next Deploy, for example nginx:alpine."
              disabled={!canEdit}
              label="Docker image"
              placeholder="nginx:alpine"
            />
          )}
        </form.AppField>

        <form.AppField name="registryChoice">
          {(f) => (
            <f.FieldSelect
              description="Where Swarm signs in to pull this image. The built-in one needs no credentials."
              disabled={!canEdit}
              label="Registry"
              options={registryItems}
            />
          )}
        </form.AppField>

        <form.Subscribe selector={selectRegistryChoice}>
          {(choice) =>
            choice === NEW_REGISTRY ? (
              <FieldGroup className="grid gap-x-6 gap-y-7 sm:grid-cols-2">
                <form.AppField name="registryName">
                  {(f) => (
                    <f.FieldText
                      description="What you will pick from when deploying another service."
                      disabled={!canEdit}
                      label="Name"
                      placeholder="ghcr"
                    />
                  )}
                </form.AppField>
                <form.AppField name="registryUrl">
                  {(f) => (
                    <f.FieldText
                      description="The hostname only, with no https:// and no path. A port is allowed."
                      disabled={!canEdit}
                      label="Registry host"
                      placeholder="ghcr.io"
                    />
                  )}
                </form.AppField>
                <form.AppField name="registryUsername">
                  {(f) => <f.FieldText disabled={!canEdit} label="Username" />}
                </form.AppField>
                <form.AppField name="registryPassword">
                  {(f) => (
                    <f.FieldPassword
                      autoComplete="new-password"
                      disabled={!canEdit}
                      label="Password or token"
                    />
                  )}
                </form.AppField>
              </FieldGroup>
            ) : null
          }
        </form.Subscribe>
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
            type="submit"
            size="sm"
            variant="outline"
          >
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </div>
      ) : null}
    </form>
  );
}

const FORGE_LABEL = Object.freeze({ github: "GitHub", gitlab: "GitLab" });

function ForgeTab({
  canEdit,
  forge,
  service,
}: {
  canEdit: boolean;
  forge: "github" | "gitlab";
  service: ServiceRow;
}) {
  const providers = useQuery(queries.gitProviders());

  const connected = (providers.data ?? []).filter(
    (p) => p.connected && p.providerType === forge
  );

  if (providers.isPending) {
    return (
      <div className="flex justify-center p-12">
        <Spinner />
      </div>
    );
  }

  if (connected.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          {forge === "gitlab" ? <GitlabIcon /> : <GithubIcon />}
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{FORGE_LABEL[forge]} is not connected</EmptyTitle>
          <EmptyDescription>
            Connect a {FORGE_LABEL[forge]} account to pick a repository from a
            list and deploy on every push. To clone a public repository by URL
            instead, use the Git tab.
          </EmptyDescription>
        </EmptyHeader>
        {canEdit ? (
          <EmptyContent>
            <Button
              nativeButton={false}
              render={<Link to="/git-providers" />}
              variant="outline"
            >
              {forge === "gitlab" ? (
                <GitlabIcon data-icon="inline-start" />
              ) : (
                <GithubIcon data-icon="inline-start" />
              )}
              Connect {FORGE_LABEL[forge]}
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }

  return (
    <GitSourceForm canEdit={canEdit} service={service} sourceType={forge} />
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
            <ForgeTab canEdit={canEdit} forge="github" service={service} />
          </TabsContent>
          <TabsContent value="gitlab">
            <ForgeTab canEdit={canEdit} forge="gitlab" service={service} />
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
