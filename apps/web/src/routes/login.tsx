// Sign in, or create the single admin account on first boot.
//
// One screen for both: on a fresh install there is no one to sign in, and on
// an already-running install there is no one left to create. Two separate
// pages would always be showing the wrong one.
import {
  adminSetupSchema,
  MIN_PASSWORD_LENGTH,
  signInFormSchema,
} from "@noddle/shared/validation/account";
import { GithubLogoIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type SubmitEvent, useCallback, useState } from "react";
import { useAppForm } from "@/components/fields/lib/form";
import { NoddleMark } from "@/components/noddle-mark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { getAuthState } from "@/server/auth";

const SOURCE_URL = "https://github.com/lucien-loua/noddle";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (state.signedIn) {
      throw redirect({ to: "/" });
    }
    return { needsSetup: state.needsSetup };
  },
  component: LoginPage,
  loader: ({ context }) => ({ needsSetup: context.needsSetup }),
});

// Named and hoisted: an inline selector in `form.Subscribe` gets recreated
// on every render and forces a resubscribe.
function selectSubmitting(state: { isSubmitting: boolean }) {
  return state.isSubmitting;
}

function Brand({ className }: { className?: string }) {
  return (
    <div className={className}>
      <NoddleMark className="size-7 shrink-0" />
      <span className="font-semibold text-xl">Noddle</span>
    </div>
  );
}

function LoginPage() {
  const { needsSetup } = Route.useLoaderData();
  const router = useRouter();

  // Rejections coming back from better-auth — wrong password, address already
  // taken. The per-field messages are Zod's and live on the fields.
  const [error, setError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: { confirmPassword: "", email: "", name: "", password: "" },
    onSubmit: async ({ value }) => {
      setError(null);

      const { error: authError } = needsSetup
        ? await authClient.signUp.email({
            email: value.email,
            name: value.name,
            password: value.password,
          })
        : await authClient.signIn.email({
            email: value.email,
            password: value.password,
          });

      if (authError) {
        setError(authError.message ?? "Authentication failed.");
        return;
      }

      await router.invalidate();
      await router.navigate({ to: "/" });
    },
    validators: { onDynamic: needsSetup ? adminSetupSchema : signInFormSchema },
  });

  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      form.handleSubmit();
    },
    [form]
  );

  return (
    <main className="grid min-h-dvh lg:grid-cols-2">
      <div className="hidden flex-col justify-between border-r bg-muted/40 p-10 lg:flex">
        <Brand className="flex items-center gap-2" />

        <div className="flex flex-col items-start gap-4">
          <p className="max-w-xs text-muted-foreground leading-snug">
            Deploy from a git repo to your own server.
          </p>
          <a
            className="flex items-center gap-2 text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
            href={SOURCE_URL}
            rel="noreferrer"
            target="_blank"
          >
            <GithubLogoIcon className="size-4 shrink-0" weight="fill" />
            Source on GitHub
          </a>
        </div>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <Brand className="mb-8 flex items-center justify-center gap-2 lg:hidden" />

          <div className="mb-6 flex flex-col gap-1.5">
            <h1 className="font-semibold text-xl">
              {needsSetup ? "Create the admin account" : "Sign in"}
            </h1>
            {needsSetup ? (
              <p className="text-muted-foreground text-sm">
                This first account owns the installation. There is no password
                reset, so keep it somewhere safe.
              </p>
            ) : null}
          </div>

          {/* `noValidate` keeps `type="email"` for the mobile keyboard and for
              password managers, without letting the browser judge the field
              first: its bubble would preempt Zod and say something else. */}
          <form noValidate onSubmit={submit}>
            <FieldGroup>
              {needsSetup ? (
                <form.AppField name="name">
                  {(f) => (
                    <f.FieldText
                      autoComplete="name"
                      label="Full name"
                      placeholder="Jane Doe"
                      required
                    />
                  )}
                </form.AppField>
              ) : null}

              <form.AppField name="email">
                {(f) => (
                  <f.FieldText
                    autoComplete="username"
                    label="Email address"
                    placeholder="jane@example.com"
                    required
                    type="email"
                  />
                )}
              </form.AppField>

              <form.AppField name="password">
                {(f) => (
                  <f.FieldPassword
                    autoComplete={
                      needsSetup ? "new-password" : "current-password"
                    }
                    description={
                      needsSetup
                        ? `At least ${MIN_PASSWORD_LENGTH} characters.`
                        : undefined
                    }
                    label="Password"
                    required
                  />
                )}
              </form.AppField>

              {needsSetup ? (
                <form.AppField name="confirmPassword">
                  {(f) => (
                    <f.FieldPassword
                      autoComplete="new-password"
                      label="Confirm password"
                      required
                    />
                  )}
                </form.AppField>
              ) : null}

              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              <form.Subscribe selector={selectSubmitting}>
                {(submitting) => (
                  <Button
                    className="w-full"
                    disabled={submitting}
                    type="submit"
                  >
                    {submitting ? <Spinner data-icon="inline-start" /> : null}
                    {needsSetup ? "Create account" : "Sign in"}
                  </Button>
                )}
              </form.Subscribe>
            </FieldGroup>
          </form>
        </div>
      </div>
    </main>
  );
}
