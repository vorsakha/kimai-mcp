import type { KimaiClient } from "./kimai.ts";
import { Activity, Project } from "./schemas.ts";

// Regular Kimai accounts can read the project and activity collections but get 403 from their
// detail endpoints (/projects/{id}, /activities/{id}), so every lookup goes through a collection.

/** Every accessible project, including hidden ones and ones outside their start/end dates. */
const ALL_PROJECTS = { ignoreDates: 1, visible: 3 };

export async function findProject(client: KimaiClient, id: number): Promise<Project | undefined> {
  const projects = await client.get("/projects", Project.array(), ALL_PROJECTS);

  return projects.find((project) => project.id === id);
}

/**
 * Activities for a project as Kimai returns them, re-checked here: Kimai drops a project filter it
 * cannot resolve and would then return every activity. Global activities only apply when the project allows them.
 */
export async function projectActivities(
  client: KimaiClient,
  project: Project,
  query: { term?: string | undefined; visible?: number },
): Promise<Activity[]> {
  const activities = await client.get("/activities", Activity.array(), { ...query, project: project.id });

  return activities.filter(
    (activity) => activity.project === project.id || (activity.project == null && project.globalActivities !== false),
  );
}
