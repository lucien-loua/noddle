// Connexion, ou création de l'unique compte administrateur au premier
// démarrage.
//
// Un seul écran pour les deux : sur une installation neuve il n'y a personne à
// connecter, et sur une installation en service il n'y a plus personne à
// créer. Deux pages afficheraient toujours la mauvaise.
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { getAuthState } from "@/server/auth";

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

function LoginPage() {
  const { needsSetup } = Route.useLoaderData();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleEmail = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value),
    []
  );

  const handlePassword = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value),
    []
  );

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);

      const { error: authError } = needsSetup
        ? await authClient.signUp.email({
            email,
            // better-auth exige un nom à l'inscription. Le demander séparément
            // ferait un champ de plus sur un écran qui n'en a pas besoin.
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
    [email, needsSetup, password, router]
  );

  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {needsSetup ? "Create the admin account" : "Noddle"}
          </CardTitle>
          <CardDescription>
            {needsSetup
              ? "This is the first account of this installation."
              : "Sign in to continue."}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email address</FieldLabel>
                <Input
                  autoComplete="username"
                  id="email"
                  onChange={handleEmail}
                  required
                  type="email"
                  value={email}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  autoComplete={
                    needsSetup ? "new-password" : "current-password"
                  }
                  id="password"
                  minLength={8}
                  onChange={handlePassword}
                  required
                  type="password"
                  value={password}
                />
              </Field>

              <Button className="w-full" disabled={busy} type="submit">
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {needsSetup ? "Create account" : "Sign in"}
              </Button>

              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
