import { z } from "zod";

import { HTTP_OR_HTTPS_URL, HTTPS_URL } from "./common.ts";

export const notificationKindSchema = z.enum(
  ["webhook", "discord", "slack"],
  "Choose a channel type."
);

export const notificationUrlSchema = z
  .string()
  .min(1, "Enter the webhook URL.")
  .max(1024, "Keep the URL under 1024 characters.")
  .refine(
    (v) => HTTP_OR_HTTPS_URL.test(v),
    "expected an http:// or https:// URL"
  );

function hostedChannelIsHttps(data: {
  kind: "discord" | "slack" | "webhook";
  url?: string;
}): boolean {
  if (data.kind === "webhook" || !data.url) {
    return true;
  }
  return HTTPS_URL.test(data.url);
}

const HOSTED_HTTPS_MESSAGE = "Discord and Slack only accept https:// URLs";

export const notificationChannelSchema = z
  .object({
    kind: notificationKindSchema,
    name: z
      .string()
      .min(1, "Give this channel a name.")
      .max(64, "Keep the name under 64 characters."),
    notifySuccess: z.boolean().default(false),
    url: notificationUrlSchema,
  })
  .refine(hostedChannelIsHttps, HOSTED_HTTPS_MESSAGE);

export type NotificationChannelInput = z.infer<
  typeof notificationChannelSchema
>;

export const notificationChannelUpdateSchema = z
  .object({
    channelId: z.uuid("Choose a channel."),
    enabled: z.boolean(),
    kind: notificationKindSchema,
    name: z
      .string()
      .min(1, "Give this channel a name.")
      .max(64, "Keep the name under 64 characters."),
    notifySuccess: z.boolean(),
    url: notificationUrlSchema.optional(),
  })
  .refine(hostedChannelIsHttps, HOSTED_HTTPS_MESSAGE);

export type NotificationChannelUpdate = z.infer<
  typeof notificationChannelUpdateSchema
>;

export const notificationChannelIdSchema = z.object({
  channelId: z.uuid("Choose a channel."),
});
