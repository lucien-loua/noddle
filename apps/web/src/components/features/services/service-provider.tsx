import {
  BUILT_IN_REGISTRY,
  type GitSourceType,
  isGitSourceType,
  NEW_REGISTRY,
  type ServiceDockerProviderInput,
  type ServiceGitProviderInput,
  serviceDockerProviderSchema,
  serviceGitProviderSchema,
} from "@noddle/shared/validation/service";
import { XIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
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

/**
 * Hoisted, like every other selector here: an inline one is recreated on
 * each render and forces a resubscribe. Same shape as
 * `selectProviderRegion` in `s3-destination-form.ts`.
 */
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

/** Real branches of the picked repository, searchable. */
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
  // Real branches, not a free-text guess: a branch that does not exist
  // fails the clone, and it fails on the SERVER, minutes later.
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

/**
 * Pick the repository from a connected forge instead of pasting a URL.
 *
 * Choosing one writes BOTH the connection and the repository URL: the clone
 * still runs against a URL, the connection only says who authenticates it.
 * Leaving them out of step is what would produce a service that looks
 * connected and clones anonymously.
 */
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
  /** The tab this field belongs to. Only its own forge is offered. */
  forge: "github" | "gitlab";
  onBranchChange: (next: string) => void;
  onPick: (repo: ProviderRepo) => void;
  onProviderChange: (next: string) => void;
  providerId: string | null;
  repoUrl: string;
}) {
  const providers = useQuery({ ...queries.gitProviders(), enabled: canEdit });
  const repos = useQuery({
    ...queries.providerRepositories(providerId ?? ""),
    enabled: canEdit && providerId !== null,
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

  // Scoped to THIS tab's forge. Offering every connection made the tabs
  // interchangeable — the GitHub tab listed GitLab connections, which is
  // the thing that made them all look the same.
  //
  // And only connections that can actually list something: an App created
  // but never installed would offer an empty list with no way to tell why.
  const connected = (providers.data ?? []).filter(
    (p) => p.connected && p.providerType === forge
  );

  // One connection is not a choice, so it is not asked for. Two or more
  // stays unselected until the user says which — picking silently would
  // bind the repository to an account they did not choose.
  //
  // This also repairs a service left over from when this tab offered
  // "Paste a URL": it sits on a forge tab with no connection at all, a
  // state the screen no longer has any way to represent.
  const only = connected.length === 1 ? connected[0] : undefined;
  useEffect(() => {
    if (providerId === null && only) {
      onProviderChange(only.id);
    }
  }, [onProviderChange, only, providerId]);

  // The unconnected case never reaches here — `ForgeTab` replaces the whole
  // tab with an empty state before this renders.
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
          value={providerId}
        >
          <SelectTrigger aria-label="Connection" id="git-provider">
            <SelectValue placeholder="Choose a connection" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {connected.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {/* The forge, not just the name a user typed: two
                      connections can be called anything. */}
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

      {providerId ? (
        <Field>
          <FieldLabel htmlFor="git-repository">Repository</FieldLabel>
          {repos.isError ? (
            <FieldDescription className="text-destructive">
              {errorMessage(repos.error, "could not list repositories")}
            </FieldDescription>
          ) : null}
          {/* A combobox and not a select: an installation can expose
              hundreds of repositories, and a list you scroll is unusable
              where a list you type into is not. */}
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

      {providerId && selectedRepo ? (
        <ProviderBranchField
          branch={branch}
          canEdit={canEdit}
          fullName={selectedRepo.fullName}
          onChange={onBranchChange}
          providerId={providerId}
        />
      ) : null}
    </>
  );
}

/** Autodeploy is not armed: registration was refused and stays refused. */
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
          buildMethod: service.buildMethod === "image" ? "railpack" : undefined,
          buildPath: value.buildPath,
          deployKeyId: value.deployKeyId,
          gitBranch: value.gitBranch,
          // The custom tab is BY URL by definition: switching to it drops
          // the connection, otherwise a service keeps cloning through a
          // forge the screen no longer shows.
          gitProviderId: sourceType === "git" ? null : value.gitProviderId,
          // Dropped along with the connection on the custom tab: a typed URL
          // carries no forge name, and a stale one would match the wrong
          // repository's pushes.
          gitRepoFullName: sourceType === "git" ? null : value.gitRepoFullName,
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: repo fields are the TRIGGER
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

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  // Picking a repository sets the branch too: the default branch is right
  // far more often than whatever the previous repository used, and a stale
  // branch here fails the clone rather than the save.
  const handlePick = useCallback(
    (repo: ProviderRepo) => {
      form.setFieldValue("gitRepoUrl", repo.url);
      // The forge's own name for the repository, which is what its webhook
      // payload carries. Recorded at the pick because it is the only moment
      // Noddle is told it — deriving it from the URL afterwards cannot work
      // across forges.
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
    <>
      <FieldGroup>
        {/* SUBSCRIBED, and that is the fix: `form.state.values.x` is a
            plain read that re-renders nothing. This block sat inside
            `AppField name="gitProviderId"`, which only re-renders when THAT
            field changes — while picking a repository writes `gitRepoUrl`,
            `gitRepoFullName` and `gitBranch`, none of them that one. The
            combobox therefore kept displaying the previous value until
            something else forced a render, such as pressing Save. */}
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
        {/* A deploy key is the answer for a repository behind NO provider
            (ADR-0019). A connected forge authenticates on its own, so the
            field only belongs on the custom tab. */}
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

  const registries = useQuery({
    ...queries.registryOptions(),
    enabled: canEdit,
  });

  const save = useMutation({
    mutationFn: async (value: ServiceDockerProviderInput) => {
      // Creating the registry FIRST: the service must never end up pointing
      // at a registry that failed to save, and `saveRegistry` hands back the
      // id so there is no lookup by name to race.
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
          buildMethod: "image",
          dockerImage: value.dockerImage,
          serviceId: service.id,
          sourceType: "docker_image",
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: image field is the TRIGGER
  useEffect(() => {
    form.reset();
  }, [form.reset, service.dockerImage]);

  const handleSubmit = useCallback(() => form.handleSubmit(), [form]);

  const registryItems = [
    { label: "Built-in registry", value: BUILT_IN_REGISTRY },
    ...(registries.data ?? []).map((r) => ({ label: r.name, value: r.id })),
    { label: "Add a registry…", value: NEW_REGISTRY },
  ];

  return (
    <>
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

        {/* Only while creating. These are the fields of a `registries` row,
            shown here so adding a private registry does not send the user to
            another screen mid-task — the credentials still land encrypted in
            that shared table, never on the service. */}
        <form.Subscribe selector={selectRegistryChoice}>
          {(choice) =>
            choice === NEW_REGISTRY ? (
              // A nested FieldGroup and not a bare <div>: the grid has to sit
              // on something that still gives each field its own label spacing.
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
                      description="The hostname only — no https:// and no path. A port is allowed."
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

const FORGE_LABEL = Object.freeze({ github: "GitHub", gitlab: "GitLab" });

/**
 * A forge tab, gated on that forge actually being connected.
 *
 * Without the gate every tab rendered the same form, so GitHub, GitLab and Git
 * were three names for one screen — the tabs looked like a choice that changed
 * nothing. A forge tab only means something once a connection exists, and until
 * then the honest answer is where to go, not a form that cannot use the forge.
 *
 * Cloning a URL by hand is NOT lost: that is what the Git tab is, and the empty
 * state points at it. That is also what makes the two tabs distinct rather than
 * interchangeable.
 */
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

  // Loading is NOT emptiness. Rendering the empty state first would flash
  // "not connected" at someone who is connected, every single time.
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
