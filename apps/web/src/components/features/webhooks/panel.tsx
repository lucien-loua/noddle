import { ArrowClockwiseIcon, CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useCopyFeedback } from "@/components/copyable-value";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
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
import { Spinner } from "@/components/ui/spinner";

export interface WebhookStatus {
  configured: boolean;
  path: string;
}

interface Props {
  /** `service:create` — the server requires the same permission as a
   *  connected repository, a webhook secret being just as much a way to
   *  trigger a deploy. */
  canManage: boolean;
  generateWebhook: () => Promise<{ path: string; secret: string }>;
  getWebhook: () => Promise<WebhookStatus>;
  queryKey: readonly unknown[];
}

const origin = typeof window === "undefined" ? "" : window.location.origin;

export function WebhookPanel({
  canManage,
  generateWebhook,
  getWebhook,
  queryKey,
}: Props) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryFn: getWebhook, queryKey });

  const generate = useMutation({
    mutationFn: generateWebhook,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const handleGenerate = useCallback(() => generate.mutate(), [generate]);

  const webhookUrl = useMemo(() => {
    if (!status.data?.configured) {
      return "";
    }
    return `${origin}${status.data.path}`;
  }, [status.data]);

  if (status.isPending) {
    return (
      <Frame className="w-full" variant="ghost">
        <FrameHeader>
          <FrameTitle>Webhook URL</FrameTitle>
        </FrameHeader>
        <FramePanel>
          <Spinner />
        </FramePanel>
      </Frame>
    );
  }

  return (
    <Frame className="w-full" variant="ghost">
      <FrameHeader>
        <FrameTitle>Webhook URL</FrameTitle>
        <FrameDescription>
          Use this URL in your git provider or CI to trigger a deploy on push.
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <Field>
          <FieldLabel htmlFor="webhook-url">Webhook URL</FieldLabel>
          <WebhookUrlInput
            canManage={canManage}
            generatePending={generate.isPending}
            onGenerate={handleGenerate}
            url={webhookUrl}
          />
          {status.data?.configured ? null : (
            <FieldDescription>
              Generate a webhook URL to deploy automatically on every GitHub or
              GitLab push.
            </FieldDescription>
          )}
        </Field>
      </FramePanel>
    </Frame>
  );
}

function WebhookManageButton({
  configured,
  generatePending,
  onGenerate,
}: {
  configured: boolean;
  generatePending: boolean;
  onGenerate: () => void;
}) {
  if (configured) {
    return (
      <InputGroupButton
        aria-label="Regenerate webhook URL"
        disabled={generatePending}
        onClick={onGenerate}
        size="icon-xs"
        variant="outline"
      >
        {generatePending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <ArrowClockwiseIcon />
        )}
      </InputGroupButton>
    );
  }

  return (
    <InputGroupButton
      disabled={generatePending}
      onClick={onGenerate}
      size="xs"
      variant="outline"
    >
      {generatePending ? <Spinner data-icon="inline-start" /> : null}
      Generate
    </InputGroupButton>
  );
}

function WebhookUrlInput({
  canManage,
  generatePending,
  onGenerate,
  url,
}: {
  canManage: boolean;
  generatePending: boolean;
  onGenerate: () => void;
  url: string;
}) {
  const { copied, handleCopy } = useCopyFeedback(url);
  const configured = url.length > 0;

  return (
    <>
      <InputGroup>
        <InputGroupInput
          id="webhook-url"
          placeholder={configured ? undefined : "No webhook configured yet"}
          readOnly
          value={configured ? url : ""}
        />
        <InputGroupAddon align="inline-end">
          {configured ? (
            <InputGroupButton
              aria-label="Copy webhook URL"
              onClick={handleCopy}
              size="icon-xs"
              variant="outline"
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </InputGroupButton>
          ) : null}
          {canManage ? (
            <WebhookManageButton
              configured={configured}
              generatePending={generatePending}
              onGenerate={onGenerate}
            />
          ) : null}
        </InputGroupAddon>
      </InputGroup>
      <span aria-live="polite" className="sr-only">
        {copied ? "Webhook URL copied" : ""}
      </span>
    </>
  );
}
