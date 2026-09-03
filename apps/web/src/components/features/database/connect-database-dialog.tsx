import {
  DATABASE_ENGINE_LABEL,
  DATABASE_ENGINES,
  DEFAULT_DATABASE_IMAGE,
  DEFAULT_DATABASE_USER,
  HAS_NAMED_DATABASE,
} from "@noddle/shared/database-spec";
import type { DatabaseEngine } from "@noddle/shared/database-spec";
import { generateDatabasePassword } from "@noddle/shared/password";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";

import { DatabaseMark } from "@/components/features/database/database-mark";
import { NoServersEmpty } from "@/components/features/servers/no-servers-empty";
import { useAppForm } from "@/components/fields/lib/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroupButton } from "@/components/ui/input-group";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { connectDatabase } from "@/server/databases";
import type { ServerView } from "@/server/servers";

const STEPS = [
  { name: "engine", required: true },
  { name: "details", required: true },
] as const;

type StepName = (typeof STEPS)[number]["name"];

const STEP_COPY: Record<StepName, { description: string; title: string }> = {
  details: {
    description: "Credentials are ready to use. Change only if needed.",
    title: "Details",
  },
  engine: {
    description: "Cannot be changed later.",
    title: "Which engine?",
  },
};

const NON_IDENTIFIER = /[^a-z0-9_]/g;
const STARTS_LEGALLY = /^[a-z_]/;

function suggestIdentifier(serviceName: string): string {
  const folded = serviceName.toLowerCase().replace(NON_IDENTIFIER, "_");
  return STARTS_LEGALLY.test(folded) ? folded : `db_${folded}`;
}

const ENGINES = DATABASE_ENGINES;

const ENGINE_BLURB: Record<DatabaseEngine, string> = {
  mariadb: "MySQL fork, drop-in compatible",
  mongo: "Documents, no fixed schema",
  mysql: "Relational, most widely deployed",
  postgres: "Relational, the usual choice",
  redis: "In-memory cache and queues",
};

interface Props {
  environmentName?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectName?: string;
  servers: ServerView[];
}

function useConnectDatabase({
  environmentName: lockedEnvironment,
  onOpenChange,
  open,
  projectName: lockedProject,
  servers,
}: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const handleNameChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    []
  );

  const [step, setStep] = useState<StepName>("engine");
  const handleItemChange = useCallback((itemName: string) => {
    setStep(itemName as StepName);
  }, []);

  const [engine, setEngine] = useState<DatabaseEngine>("postgres");
  const handleEngineChange = useCallback((e: ChangeEvent<HTMLDivElement>) => {
    const picked = (e.target as HTMLInputElement).value;
    if ((DATABASE_ENGINES as readonly string[]).includes(picked)) {
      setEngine(picked as DatabaseEngine);
    }
  }, []);
  const hasNamedDatabase = HAS_NAMED_DATABASE[engine];

  const defaultServerId = servers[0]?.id ?? "";
  const form = useAppForm({
    defaultValues: {
      databaseName: "",
      description: "",
      environmentName: lockedEnvironment ?? "production",
      image: "",
      projectName: lockedProject ?? "default",
      rootPassword: generateDatabasePassword(),
      rootUser: "",
      serverId: defaultServerId,
    },
  });

  const regenerate = useCallback(
    () => form.setFieldValue("rootPassword", generateDatabasePassword()),
    [form]
  );

  useEffect(() => {
    if (open) {
      form.reset();
      setName("");
      setStep("engine");
      setSubmitError(null);
      form.setFieldValue("rootPassword", generateDatabasePassword());
    }
  }, [open, form.reset, form.setFieldValue]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const answers = new FormData(event.currentTarget);
      const picked = answers.get("engine");
      if (
        typeof picked !== "string" ||
        !(DATABASE_ENGINES as readonly string[]).includes(picked)
      ) {
        setSubmitError("Pick a database engine first.");
        return;
      }
      const chosen = picked as DatabaseEngine;
      const { values } = form.state;

      setPending(true);
      setSubmitError(null);
      try {
        const created = await connectDatabase({
          data: {
            databaseName: hasNamedDatabase
              ? values.databaseName || undefined
              : undefined,
            description: values.description || undefined,
            engine: chosen,
            environmentName: values.environmentName,
            image: values.image || undefined,
            name,
            projectName: values.projectName,
            rootPassword: values.rootPassword || undefined,
            rootUser: hasNamedDatabase
              ? values.rootUser || undefined
              : undefined,
            serverId: values.serverId,
          },
        });
        onOpenChange(false);
        await queryClient.invalidateQueries();
        await router.invalidate();
        await router.navigate({
          params: {
            databaseId: created.databaseId,
            environmentId: created.environmentId,
            projectId: created.projectId,
          },
          search: { deployment: created.deploymentId },
          to: "/projects/$projectId/$environmentId/databases/$databaseId",
        });
      } catch (error) {
        setSubmitError(errorMessage(error, "could not create the database"));
      } finally {
        setPending(false);
      }
    },
    [form, hasNamedDatabase, name, onOpenChange, queryClient, router]
  );

  const noServers = servers.length === 0;
  const lockedScope = Boolean(lockedProject && lockedEnvironment);

  return {
    engine,
    submitError,
    form,
    handleEngineChange,
    handleItemChange,
    handleNameChange,
    handleSubmit,
    hasNamedDatabase,
    lockedScope,
    name,
    noServers,
    pending,
    regenerate,
    step,
  };
}

export function ConnectDatabaseDialog(props: Props) {
  const { onOpenChange, open, servers } = props;
  const {
    engine,
    submitError,
    form,
    handleEngineChange,
    handleItemChange,
    handleNameChange,
    handleSubmit,
    hasNamedDatabase,
    lockedScope,
    name,
    noServers,
    pending,
    regenerate,
    step,
  } = useConnectDatabase(props);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{STEP_COPY[step].title}</DialogTitle>
          <DialogDescription>
            {STEP_COPY[step].description ||
              "An official image, on the server you pick."}
          </DialogDescription>
        </DialogHeader>

        {noServers ? (
          <NoServersEmpty description="A database needs a machine to run on." />
        ) : (
          <Questionnaire
            className="min-h-0 flex-1"
            items={STEPS}
            onItemChange={handleItemChange}
            onSubmit={handleSubmit}
          >
            <DialogBody>
              <QuestionnaireItem name="engine" required>
                <QuestionnaireTitle className="sr-only">
                  Which engine?
                </QuestionnaireTitle>
                <QuestionnaireChoices onChange={handleEngineChange}>
                  {ENGINES.map((option) => (
                    <QuestionnaireChoice key={option} value={option}>
                      <span className="flex items-center gap-2 font-medium">
                        <DatabaseMark engine={option} />
                        {DATABASE_ENGINE_LABEL[option]}
                      </span>
                      <QuestionnaireChoiceDescription>
                        {ENGINE_BLURB[option]}
                      </QuestionnaireChoiceDescription>
                    </QuestionnaireChoice>
                  ))}
                </QuestionnaireChoices>
                <QuestionnaireError />
              </QuestionnaireItem>

              <QuestionnaireItem name="details" required>
                <QuestionnaireTitle className="sr-only">
                  Details
                </QuestionnaireTitle>
                <FieldGroup>
                  {lockedScope ? null : (
                    <div className="grid grid-cols-2 gap-4">
                      <form.AppField name="projectName">
                        {(f) => <f.FieldText label="Project" required />}
                      </form.AppField>
                      <form.AppField name="environmentName">
                        {(f) => <f.FieldText label="Environment" required />}
                      </form.AppField>
                    </div>
                  )}

                  <Field>
                    <FieldLabel htmlFor="db-name">Name</FieldLabel>
                    <QuestionnaireInput
                      id="db-name"
                      onChange={handleNameChange}
                      placeholder="my-database"
                      value={name}
                    />
                  </Field>

                  <form.AppField name="serverId">
                    {(f) => (
                      <f.FieldCombobox
                        emptyText="No server matches."
                        items={servers}
                        itemToId={(server) => server.id}
                        itemToStringLabel={(server) => server.name}
                        itemToStringValue={(server) =>
                          `${server.name} · ${server.host}`
                        }
                        label="Server"
                        placeholder="Search servers…"
                        renderItem={(server) => (
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="truncate">{server.name}</span>
                            <span className="font-normal text-muted-foreground text-xs">
                              {server.host}
                            </span>
                          </span>
                        )}
                      />
                    )}
                  </form.AppField>

                  {hasNamedDatabase ? (
                    <div className="grid grid-cols-2 gap-4">
                      <form.AppField name="databaseName">
                        {(f) => (
                          <f.FieldText
                            label="Database name"
                            placeholder={suggestIdentifier(
                              name || "my_database"
                            )}
                          />
                        )}
                      </form.AppField>
                      <form.AppField name="rootUser">
                        {(f) => (
                          <f.FieldText
                            label="User"
                            placeholder={DEFAULT_DATABASE_USER[engine] ?? ""}
                          />
                        )}
                      </form.AppField>
                    </div>
                  ) : null}

                  <form.AppField name="rootPassword">
                    {(f) => (
                      <f.FieldPassword
                        addonEnd={
                          <InputGroupButton
                            aria-label="Generate a new password"
                            onClick={regenerate}
                            size="icon-xs"
                          >
                            <ArrowsClockwiseIcon weight="regular" />
                          </InputGroupButton>
                        }
                        label="Password"
                      />
                    )}
                  </form.AppField>

                  <form.AppField name="image">
                    {(f) => (
                      <f.FieldText
                        description="Can be changed later from Advanced → Configuration."
                        label="Image"
                        placeholder={DEFAULT_DATABASE_IMAGE[engine]}
                      />
                    )}
                  </form.AppField>

                  <form.AppField name="description">
                    {(f) => <f.FieldTextarea label="Description (optional)" />}
                  </form.AppField>
                </FieldGroup>
              </QuestionnaireItem>
            </DialogBody>

            {submitError ? (
              <Alert variant="destructive">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <QuestionnaireActions>
                <QuestionnairePrevious />
                <QuestionnaireNext />
                <QuestionnaireSubmit disabled={pending || !name}>
                  {pending ? <Spinner data-icon="inline-start" /> : null}
                  Add database
                </QuestionnaireSubmit>
              </QuestionnaireActions>
            </DialogFooter>
          </Questionnaire>
        )}
      </DialogContent>
    </Dialog>
  );
}
