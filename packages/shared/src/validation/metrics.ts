import { z } from "zod";

export const serviceMetricsRequestSchema = z.object({
  serviceId: z.uuid("Choose a service."),
});

export const databaseMetricsRequestSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  windowHours: z.enum(["1", "6", "24"], "Choose a time window.").default("6"),
});
