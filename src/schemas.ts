import { z } from "zod";

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

export const Project = z.object({
  id: z.number(),
  name: z.string(),
  customer: z.number().nullish(),
  parentTitle: z.string().nullish(),
  globalActivities: z.boolean().optional(),
});

export const Activity = z.object({
  id: z.number(),
  name: z.string(),
  project: z.number().nullish(),
  parentTitle: z.string().nullish(),
});

const ExpandedProject = NamedRef.extend({
  customer: NamedRef.nullish().catch(null),
});

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
