import { z } from "zod";

import { HTTP_OR_HTTPS_URL, HTTPS_URL } from "./common.ts";

export const notificationKindSchema = z.enum(["webhook", "discord", "slack"]);

/**
 * A channel's URL.
 *
 * `http` is accepted, `https` required for Discord and Slack. These URLs
 * are bearer secrets — whoever holds them can post to the channel — so
 * letting them travel in plaintext isn't harmless. But a homegrown webhook
 * on an internal service (`http://10.0.0.5:5678`) is a legitimate and
 * frequent case in self-hosting; forbidding it wouldn't secure anyone, it
 * would push people to bypass Noddle.
 */
export const notificationUrlSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) => HTTP_OR_HTTPS_URL.test(v),
    "expected an http:// or https:// URL"
  );

/**
 * Discord and Slack ONLY serve https: an `http` URL for them isn't an
 * infrastructure choice, it's a typo that would fail on the first
 * delivery attempt. We reject it in the form rather than at the moment an
 * alert was supposed to go out.
 */
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
    name: z.string().min(1).max(64),
    notifySuccess: z.boolean().default(false),
    url: notificationUrlSchema,
  })
  .refine(hostedChannelIsHttps, HOSTED_HTTPS_MESSAGE);

export type NotificationChannelInput = z.infer<
  typeof notificationChannelSchema
>;

/**
 * Editing an existing channel. The URL is optional: it never comes back
 * from the server — same rule as the S3 secret key and a database
 * password — so leaving it empty means "keep the previous one".
 */
export const notificationChannelUpdateSchema = z
  .object({
    channelId: z.uuid(),
    enabled: z.boolean(),
    kind: notificationKindSchema,
    name: z.string().min(1).max(64),
    notifySuccess: z.boolean(),
    url: notificationUrlSchema.optional(),
  })
  .refine(hostedChannelIsHttps, HOSTED_HTTPS_MESSAGE);

export type NotificationChannelUpdate = z.infer<
  typeof notificationChannelUpdateSchema
>;

export const notificationChannelIdSchema = z.object({ channelId: z.uuid() });
