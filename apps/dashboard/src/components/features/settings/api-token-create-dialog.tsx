import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  FocusModal,
  FocusModalBody,
  FocusModalContent,
  FocusModalFooter,
  FocusModalHeader,
  FocusModalTitle,
} from "@/components/ui/focus-modal";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import { DESTRUCTIVE_SCOPES, presetScopes, SCOPE_PRESETS } from "@/lib/scopes";
import { copyText } from "@/lib/secure-context";
import { createApiToken, getGrantableScopes } from "@/server/api-tokens";

const EXPIRY_OPTIONS = [
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
  { label: "1 year", value: "365" },
  { label: "Never expires", value: "never" },
];

function groupByResource(scopes: string[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const scope of scopes) {
    const resource = scope.split(":")[0] ?? scope;
    groups.set(resource, [...(groups.get(resource) ?? []), scope]);
  }
  return [...groups.entries()];
}

function Reveal({ onDone, token }: { onDone: () => void; token: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    await copyText(token);
    setCopied(true);
  }, [token]);

  return (
    <>
      <FocusModalBody className="space-y-4">
        <p className="text-sm">
          Copy it now. Noddle stores only a hash, so this is the only time it
          can be shown.
        </p>
        <code className="block break-all rounded-2xl bg-muted p-3 font-mono text-xs">
          {token}
        </code>
        <FieldDescription>
          Send it as <code className="font-mono">Authorization: Bearer …</code>{" "}
          and check it with{" "}
          <code className="font-mono">GET /api/v1/whoami</code>.
        </FieldDescription>
      </FocusModalBody>
      <FocusModalFooter>
        <Button onClick={copy} variant="outline">
          {copied ? "Copied" : "Copy token"}
        </Button>
        <Button onClick={onDone}>Done</Button>
      </FocusModalFooter>
    </>
  );
}

export function ApiTokenCreateDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [chosen, setChosen] = useState<string[]>([]);
  const [issued, setIssued] = useState<string | null>(null);

  const grantable = useQuery<string[]>({
    enabled: open,
    queryFn: () => getGrantableScopes(),
    queryKey: ["grantable-scopes"],
  });

  const groups = useMemo(
    () => groupByResource(grantable.data ?? []),
    [grantable.data]
  );

  const create = useMutation({
    mutationFn: () =>
      createApiToken({
        data: {
          expiresInDays: expiry === "never" ? null : Number(expiry),
          name: name.trim(),
          scopes: chosen,
        },
      }),
    onError: (error: Error) =>
      toast.add({
        description: errorMessage(error, "could not create the token"),
        title: "Token not created",
        type: "error",
      }),
    onSuccess: (result) => {
      setIssued(result.token);
      client.invalidateQueries({ queryKey: queries.apiTokens().queryKey });
    },
  });

  const close = useCallback(() => {
    setIssued(null);
    setName("");
    setChosen([]);
    setExpiry("90");
    onOpenChange(false);
  }, [onOpenChange]);

  const toggle = useCallback((scope: string) => {
    setChosen((current) =>
      current.includes(scope)
        ? current.filter((s) => s !== scope)
        : [...current, scope]
    );
  }, []);

  const applyPreset = useCallback(
    (preset: (typeof SCOPE_PRESETS)[number]) =>
      setChosen(presetScopes(preset, grantable.data ?? [])),
    [grantable.data]
  );
  const clearScopes = useCallback(() => setChosen([]), []);

  const submit = useCallback(() => create.mutate(), [create]);
  const ready = name.trim().length > 0 && chosen.length > 0;

  return (
    <FocusModal onOpenChange={issued ? close : onOpenChange} open={open}>
      <FocusModalContent>
        <FocusModalHeader>
          <FocusModalTitle>
            {issued ? "Your new token" : "New API token"}
          </FocusModalTitle>
        </FocusModalHeader>

        {issued ? (
          <Reveal onDone={close} token={issued} />
        ) : (
          <>
            <FocusModalBody className="min-h-0 space-y-14 overflow-y-auto">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="token-name">Name</FieldLabel>
                  <Input
                    id="token-name"
                    onChange={(event) => setName(event.target.value)}
                    placeholder="ci-deploy"
                    value={name}
                  />
                  <FieldDescription>
                    What this token is for. It is how you will recognise it to
                    revoke it.
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="token-expiry">Expires</FieldLabel>
                  <Select
                    onValueChange={(value) =>
                      setExpiry(typeof value === "string" ? value : "90")
                    }
                    value={expiry}
                  >
                    <SelectTrigger className="w-48" id="token-expiry" size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {EXPIRY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {expiry === "never" ? (
                    <FieldDescription>
                      A token that never expires is the most common way a
                      credential outlives the person who made it.
                    </FieldDescription>
                  ) : null}
                </Field>
              </FieldGroup>

              <FieldSet>
                <div className="flex items-baseline justify-between gap-3">
                  <FieldLegend>Permissions</FieldLegend>
                  <span className="flex items-center gap-3">
                    {chosen.length > 0 ? (
                      <Button
                        className="h-auto p-0 text-xs"
                        onClick={clearScopes}
                        type="button"
                        variant="link"
                      >
                        Clear
                      </Button>
                    ) : null}
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {chosen.length} selected
                    </span>
                  </span>
                </div>
                <FieldDescription>
                  Nothing is selected by default, and this list already stops at
                  what your own role allows. Start from{" "}
                  {SCOPE_PRESETS.map((preset, index) => (
                    <span key={preset.label}>
                      {index > 0 ? " or " : null}
                      <Button
                        className="h-auto p-0 align-baseline text-xs"
                        onClick={() => applyPreset(preset)}
                        type="button"
                        variant="link"
                      >
                        {preset.label.toLowerCase()}
                      </Button>
                    </span>
                  ))}
                  , or pick them yourself.
                </FieldDescription>

                <div className="gap-8 sm:columns-2 lg:columns-3 xl:columns-4">
                  {groups.map(([resource, scopes]) => (
                    <section
                      className="mb-6 break-inside-avoid space-y-2.5"
                      key={resource}
                    >
                      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
                        {resource}
                      </h3>
                      <div className="flex flex-col gap-1.5">
                        {scopes.map((scope) => {
                          const action = scope.split(":")[1] ?? scope;
                          return (
                            <label
                              className="flex items-center gap-2 text-xs"
                              key={scope}
                            >
                              <Checkbox
                                checked={chosen.includes(scope)}
                                onCheckedChange={() => toggle(scope)}
                              />
                              <span className="min-w-0 flex-1 font-mono">
                                {action}
                              </span>
                              {DESTRUCTIVE_SCOPES.has(scope) ? (
                                <span className="text-destructive">
                                  destructive
                                </span>
                              ) : null}
                            </label>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              </FieldSet>
            </FocusModalBody>

            <FocusModalFooter>
              <Button onClick={close} variant="outline">
                Cancel
              </Button>
              <Button disabled={!ready || create.isPending} onClick={submit}>
                {create.isPending ? <Spinner data-icon="inline-start" /> : null}
                Create token
              </Button>
            </FocusModalFooter>
          </>
        )}
      </FocusModalContent>
    </FocusModal>
  );
}
