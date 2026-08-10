// Sign in, or create the single admin account on first boot.
//
// One screen for both: on a fresh install there is no one to sign in, and on
// an already-running install there is no one left to create. Two separate
// pages would always be showing the wrong one.
import { EyeIcon, EyeSlashIcon, GithubLogoIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type SubmitEvent, useCallback, useState } from "react";
import { NoddleMark } from "@/components/noddle-mark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { getAuthState } from "@/server/auth";

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
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

  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleReveal = useCallback(() => setRevealed((shown) => !shown), []);

  const submit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const email = String(form.get("email") ?? "");
      const password = String(form.get("password") ?? "");

      setBusy(true);
      setError(null);

      const { error: authError } = needsSetup
        ? await authClient.signUp.email({
            email,
            // better-auth requires a name on sign-up. Asking for it separately
            // would add a field to a screen that doesn't need one.
            name: email.split("@")[0] ?? "admin",
            password,
          })
        : await authClient.signIn.email({ email, password });

      if (authError) {
        setError(authError.message ?? "Authentication failed.");
        setBusy(false);
        return;
      }

      await router.invalidate();
      await router.navigate({ to: "/" });
    },
    [needsSetup, router]
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

          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email address</FieldLabel>
                <Input
                  autoComplete="username"
                  id="email"
                  name="email"
                  required
                  type="email"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    autoComplete={
                      needsSetup ? "new-password" : "current-password"
                    }
                    id="password"
                    maxLength={MAX_PASSWORD}
                    minLength={MIN_PASSWORD}
                    name="password"
                    required
                    type={revealed ? "text" : "password"}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      aria-label={revealed ? "Hide password" : "Show password"}
                      onClick={toggleReveal}
                      size="icon-xs"
                    >
                      {revealed ? <EyeSlashIcon /> : <EyeIcon />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {needsSetup ? (
                  <FieldDescription>
                    At least {MIN_PASSWORD} characters.
                  </FieldDescription>
                ) : null}
              </Field>

              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              <Button className="w-full" disabled={busy} type="submit">
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {needsSetup ? "Create account" : "Sign in"}
              </Button>
            </FieldGroup>
          </form>
        </div>
      </div>
    </main>
  );
}
