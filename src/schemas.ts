import { z } from "zod";

// Only the fields this server uses are declared; Zod strips everything else,
// so unexpected or sensitive fields never reach tool output.

const NamedRef = z.object({
  id: z.number(),
  name: z.string(),
});

export const GroupBy = z.enum(["day", "project", "activity"]);

export const User = z.object({
  id: z.number(),
  username: z.string(),
  alias: z.string().nullish(),
  timezone: z.string().nullish(),
  language: z.string().nullish(),
});

export const TimesheetConfig = z.object({
  trackingMode: z.string(),
  defaultBeginTime: z.string().nullish(),
  activeEntriesHardLimit: z.number(),
  isAllowFutureTimes: z.boolean(),
  isAllowOverlapping: z.boolean(),
});

/** Project as returned by the project endpoints: customer is an ID, parentTitle its name. */
export const Project = z.object({
  id: z.number(),
  name: z.string(),
  customer: z.number().nullish(),
  parentTitle: z.string().nullish(),
  globalActivities: z.boolean().optional(),
});

/** Activity as returned by the activity endpoints: project is an ID (null for global activities). */
export const Activity = z.object({
  id: z.number(),
  name: z.string(),
  project: z.number().nullish(),
  parentTitle: z.string().nullish(),
});

const ExpandedProject = NamedRef.extend({
  customer: NamedRef.nullish().catch(null),
});

/**
 * Timesheets come in two shapes: collections requested with full=true (and /active, /recent)
 * embed project and activity objects, while single-entity responses only carry their IDs.
 */
export const Timesheet = z.object({
  id: z.number(),
  begin: z.string(),
  end: z.string().nullish(),
  duration: z.number().nullish(),
  description: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  billable: z.boolean().optional(),
  exported: z.boolean().optional(),
  project: z.union([z.number(), ExpandedProject]),
  activity: z.union([z.number(), NamedRef]),
});

export type User = z.infer<typeof User>;
export type TimesheetConfig = z.infer<typeof TimesheetConfig>;
export type Project = z.infer<typeof Project>;
export type Activity = z.infer<typeof Activity>;
export type Timesheet = z.infer<typeof Timesheet>;
export type GroupBy = z.infer<typeof GroupBy>;
