import { describe, expect, it } from "vitest";
import type { ContainerState, Deployment, ServiceDetail, Task } from "@/bindings";
import { markersBetween, serviceMarkers } from "./markers";

const deployment = (extra: Partial<Deployment>): Deployment => ({
  id: "d",
  status: "PRIMARY",
  rolloutState: "IN_PROGRESS",
  rolloutReason: null,
  taskDefinition: "arn:aws:ecs:eu-central-1:000000000000:task-definition/orders:12",
  desired: 2,
  running: 2,
  pending: 0,
  failed: 0,
  createdAt: "2026-01-01T12:00:00Z",
  updatedAt: "2026-01-01T12:00:00Z",
  ...extra,
});

const detail = (extra: Partial<ServiceDetail>): ServiceDetail =>
  ({ deployments: [], events: [], ...extra }) as unknown as ServiceDetail;

const container = (exitCode: number | null): ContainerState =>
  ({ name: "app", exitCode }) as unknown as ContainerState;

const task = (extra: Partial<Task>): Task =>
  ({
    id: "0123456789abcdef",
    stoppedAt: null,
    stoppedReason: null,
    stopCode: null,
    containers: [],
    ...extra,
  }) as unknown as Task;

describe("serviceMarkers", () => {
  it("marks a deployment's start and its end, oldest first", () => {
    const markers = serviceMarkers(
      detail({
        deployments: [
          deployment({
            rolloutState: "FAILED",
            rolloutReason: "tasks failed to start",
            updatedAt: "2026-01-01T12:10:00Z",
          }),
        ],
      }),
      [],
    );
    expect(markers.map((m) => [m.title, m.detail, m.failed])).toEqual([
      ["Deployment of orders:12 started", null, false],
      ["Deployment of orders:12 failed", "tasks failed to start", true],
    ]);
  });

  it("doesn't mark the end of a deployment that was replaced", () => {
    const markers = serviceMarkers(
      detail({ deployments: [deployment({ status: "ACTIVE", rolloutState: "COMPLETED" })] }),
      [],
    );
    expect(markers.map((m) => m.title)).toEqual(["Deployment of orders:12 started"]);
  });

  it("marks stopped tasks with their reason and exit codes", () => {
    const [marker] = serviceMarkers(null, [
      task({ id: "abc", stoppedAt: "2026-01-01T12:00:00Z" }),
      task({
        stoppedAt: "2026-01-01T12:05:00Z",
        stoppedReason: "Essential container in task exited",
        containers: [container(137)],
      }),
    ]).slice(1);
    expect(marker).toMatchObject({
      kind: "task",
      title: "Task 01234567 stopped",
      detail: "Essential container in task exited · app exited with 137",
      failed: true,
      taskId: "0123456789abcdef",
    });
  });

  it("leaves out steady states and events about tasks it marks itself", () => {
    const markers = serviceMarkers(
      detail({
        events: [
          {
            id: "1",
            createdAt: "2026-01-01T12:00:00Z",
            message: "(service x) has reached a steady state.",
          },
          {
            id: "2",
            createdAt: "2026-01-01T12:01:00Z",
            message: "(service x) has stopped 1 running tasks: (task abc).",
          },
          {
            id: "3",
            createdAt: "2026-01-01T12:02:00Z",
            message: "(service x) has started 1 tasks: (task def).",
          },
        ],
      }),
      [task({ id: "abc", stoppedAt: "2026-01-01T12:01:00Z" })],
    );
    expect(markers.map((m) => m.title)).toEqual([
      "Task abc stopped",
      "has started 1 tasks: (task def).",
    ]);
  });
});

describe("markersBetween", () => {
  it("takes the markers after one time up to and including the other", () => {
    const markers = serviceMarkers(
      detail({ deployments: [deployment({ createdAt: "2026-01-01T12:00:00Z" })] }),
      [],
    );
    const at = Date.parse("2026-01-01T12:00:00Z");
    expect(markersBetween(markers, at - 1, at)).toHaveLength(1);
    expect(markersBetween(markers, at, at + 1)).toHaveLength(0);
  });
});
