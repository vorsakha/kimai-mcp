import type { KimaiClient } from "./kimai.ts";
import { Activity, Project, type Timesheet } from "./schemas.ts";

const NAME_TTL_MS = 60_000;
const MAX_NAMES = 1000;

type DisplayName = { name: string; customer: { name: string } | null };

export class CatalogNames {
  readonly #names = new Map<string, { value: DisplayName; expiresAt: number }>();

  rememberProject(project: Project): void {
    this.#remember(`project:${project.id}`, {
      name: project.name,
      customer: project.parentTitle ? { name: project.parentTitle } : null,
    });
  }

  rememberActivity(activity: Activity): void {
    this.#remember(`activity:${activity.id}`, { name: activity.name, customer: null });
  }

  rememberTimesheet(entry: Timesheet): void {
    if (typeof entry.project !== "number") {
      this.#remember(`project:${entry.project.id}`, {
        name: entry.project.name,
        customer: entry.project.customer ? { name: entry.project.customer.name } : null,
      });
    }

    if (typeof entry.activity !== "number") {
      this.#remember(`activity:${entry.activity.id}`, { name: entry.activity.name, customer: null });
    }
  }

  project(id: number): DisplayName | undefined {
    return this.#get(`project:${id}`);
  }

  activity(id: number): DisplayName | undefined {
    return this.#get(`activity:${id}`);
  }

  #get(key: string): DisplayName | undefined {
    const cached = this.#names.get(key);

    if (!cached || cached.expiresAt <= Date.now()) {
      this.#names.delete(key);
      return undefined;
    }

    return cached.value;
  }

  #remember(key: string, value: DisplayName): void {
    this.#names.delete(key);
    this.#names.set(key, { value, expiresAt: Date.now() + NAME_TTL_MS });

    if (this.#names.size > MAX_NAMES) {
      this.#names.delete(this.#names.keys().next().value!);
    }
  }
}

const ALL_PROJECTS = { ignoreDates: 1, visible: 3 };

export async function findProject(client: KimaiClient, id: number): Promise<Project | undefined> {
  const projects = await client.get("/projects", Project.array(), ALL_PROJECTS);

  return projects.find((project) => project.id === id);
}

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
