import { z } from "zod";

export const serviceMetricsRequestSchema = z.object({ serviceId: z.uuid() });

export const databaseMetricsRequestSchema = z.object({
  databaseId: z.uuid(),
  /**
   * Display window (in hours) for metrics reads.
   *
   * Passed as a string because GET query params arrive as strings.
   */
  windowHours: z.enum(["1", "6", "24"]).default("6"),
});
