import assert from "node:assert/strict";
import { test } from "node:test";
import { CatalogNames } from "../src/catalog.ts";

test("display names expire after a minute and stay isolated between server instances", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-27T12:00:00Z") });
  const names = new CatalogNames();

  names.rememberTimesheet({
    id: 1,
    begin: "2026-10-27T09:00:00-0300",
    project: { id: 7, name: "Project", customer: { id: 8, name: "Customer" } },
    activity: { id: 7, name: "Activity" },
  });

  assert.equal(names.project(7)?.name, "Project");
  assert.equal(names.project(7)?.customer?.name, "Customer");
  assert.equal(names.activity(7)?.name, "Activity", "project and activity IDs have separate namespaces");
  assert.equal(new CatalogNames().project(7), undefined);

  t.mock.timers.tick(59_999);
  assert.equal(names.project(7)?.name, "Project");
  t.mock.timers.tick(1);
  assert.equal(names.project(7), undefined, "a cache hit must not extend the lifetime");
  assert.equal(names.activity(7), undefined);

  names.rememberProject({ id: 7, name: "Renamed project", parentTitle: "Customer" });
  names.rememberActivity({ id: 7, name: "Renamed activity" });
  assert.equal(names.project(7)?.name, "Renamed project");
  assert.equal(names.activity(7)?.name, "Renamed activity");
});
