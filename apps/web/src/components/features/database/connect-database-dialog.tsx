import {
  DATABASE_ENGINE_LABEL,
  DATABASE_ENGINES,
  DEFAULT_DATABASE_IMAGE,
  DEFAULT_DATABASE_USER,
  HAS_NAMED_DATABASE,
} from "@noddle/database-spec";
import type { DatabaseEngine } from "@noddle/database-spec";
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

/**
 * The order and names of the steps, declared ONCE.
 *
 * Outside the component, so it's stable across renders: `Questionnaire`
 * derives progress, the active step, and the navigation buttons' state from
 * this list — recreating it on every render would make them flicker.
 *
 * Both are `required`: each one carries an answer without which there's
 * nothing to create. That's also what removes the "Skip" button, which
 * wouldn't make sense here.
 */
const STEPS = [
  { name: "engine", required: true },
  { name: "details", required: true },
] as const;

type StepName = (typeof STEPS)[number]["name"];

/**
 * The title and sentence for each step, rendered IN THE DIALOG'S HEADER.
 *
 * They used to live at the top of the body, so they scrolled along with the
 * fields: on a short window, you'd lose sight of the question you're
 * answering. The header doesn't scroll.
 */
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

/**
 * The fallback that folds a service name into a SQL identifier, COPIED from
 * `server/databases.ts`.
 *
 * Copied on purpose: here it's a SUGGESTION shown in a field the user can
 * overwrite, there it's the value used when the field arrives empty.
 * Sharing them would suggest a guarantee that nothing actually enforces —
 * and the server must be able to cope without the client regardless.
 */
function suggestIdentifier(serviceName: string): string {
  const folded = serviceName.toLowerCase().replace(NON_IDENTIFIER, "_");
  return STARTS_LEGALLY.test(folded) ? folded : `db_${folded}`;
}

// The list comes from the shared module: it's the one Zod accepts and the
// worker knows how to start. Duplicating it here would risk offering an
// engine the server refuses, or hiding one it handles.
const ENGINES = DATABASE_ENGINES;

const ENGINE_BLURB: Record<DatabaseEngine, string> = {
  mariadb: "MySQL fork, drop-in compatible",
  mongo: "Documents, no fixed schema",
  mysql: "Relational, most widely deployed",
  postgres: "Relational, the usual choice",
  redis: "In-memory cache and queues",
};

interface Props {
  /**
   * The project and environment, when the calling screen ALREADY KNOWS
   * them — an environment's page, for example. The corresponding fields
   * then disappear from the form: asking someone again for the project
   * they're already in is exactly the inconsistency this component fixes.
   * Absent (from /deployments), both fields reappear.
   */
  environmentName?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectName?: string;
  servers: ServerView[];
}

/**
 * The questionnaire's state machine: step, engine choice, generated
 * credentials, and the submit that creates the database. Separated from the
 * markup so each reads on its own.
 */
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

  // The NAME stays a `useState` mirrored onto `QuestionnaireInput`: it's THE
  // answer for the "details" step, and an `f.FieldText` wouldn't carry it —
  // see the notes on `STEPS`/`STEP_COPY` above.
  const [name, setName] = useState("");
  const handleNameChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    []
  );

  /**
   * The chosen engine, TRACKED in state — while the value that's
   * authoritative at submission remains the one from `FormData`.
   *
   * Two sources for the same thing, which is justified here: the
   * "credentials" step needs to know whether to show a user and a database
   * name (Redis has neither), so it needs the answer DURING render, which
   * `FormData` only gives at submit time. State decides nothing beyond what
   * to display; if the two ever diverged, what goes to the server would
   * still be the real choice.
   */
  const [step, setStep] = useState<StepName>("engine");
  const handleItemChange = useCallback((itemName: string) => {
    setStep(itemName as StepName);
  }, []);

  const [engine, setEngine] = useState<DatabaseEngine>("postgres");
  const handleEngineChange = useCallback((e: ChangeEvent<HTMLDivElement>) => {
    const picked = (e.target as HTMLInputElement).value;
    // Checked against the list rather than a hand-written comparison:
    // adding an engine shouldn't require remembering to update an `if`.
    if ((DATABASE_ENGINES as readonly string[]).includes(picked)) {
      setEngine(picked as DatabaseEngine);
    }
  }, []);
  const hasNamedDatabase = HAS_NAMED_DATABASE[engine];

  // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive, servers can be empty
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
      // A FRESH password on every open: `form.reset()` reverts to
      // `defaultValues`, which locks in the password drawn on the first
      // render — reusing it would give two databases sharing their secret,
      // with nothing to indicate it.
      form.setFieldValue("rootPassword", generateDatabasePassword());
    }
  }, [open, form.reset, form.setFieldValue]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // The engine that IS AUTHORITATIVE is the FormData one, not the
      // `engine` state the render uses to decide which fields to show. If
      // the two diverged, it's the real choice that would go to the server.
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
        await connectDatabase({
          data: {
            // `|| undefined` rather than `?? undefined`: a field cleared by
            // hand yields `""`, which must mean "leave the default" — not
            // "the name is the empty string", which Zod would reject with a
            // message pointing at the wrong field.
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
          /* `min-h-0 flex-1`: the questionnaire's root IS the `<form>`, and
             it's inserted between `DialogContent` and `DialogBody`. Without
             these two classes it stays an ordinary block, breaks the
             dialog's flex column, and `DialogBody` never gets a height to
             constrain against — the content then pushes the footer off
             screen instead of scrolling. This is the whole reason
             `DialogForm` exists, which this dialog can't use since its form
             comes from the preset. */
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
                {/* The radios' `change` bubbles up here: the primitive
                    doesn't expose the current answer during render, and the
                    "credentials" step needs it to know what to show. */}
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
                        // Deliberately inline: `server` is inferred from
                        // `items={servers}` in the same JSX call.
                        // biome-ignore lint/performance/noJsxPropsBind: inline for type inference, see above
                        itemToId={(server) => server.id}
                        // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
                        itemToStringLabel={(server) => server.name}
                        // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
                        itemToStringValue={(server) =>
                          `${server.name} · ${server.host}`
                        }
                        label="Server"
                        placeholder="Search servers…"
                        // biome-ignore lint/performance/noJsxPropsBind: inline for type inference
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

            {/* Outside `DialogBody`, so visible regardless of the step AND
                the scroll position: on this nine-field form, the alert used
                to end up below the fold, at the same spot as the question
                it answers. */}
            {submitError ? (
              <Alert variant="destructive">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              {/* `QuestionnaireActions` places Previous / Next / Submit
                  itself: Next isn't shown on the last step and Submit is
                  shown only there. Nothing to manage by hand. */}
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
