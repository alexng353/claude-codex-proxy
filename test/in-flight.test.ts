import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inFlightPath, markThreadInFlight, sharedThreadsInFlight } from "../src/in-flight";

let root: string;
let previous: string | undefined;
let observer: Database;
beforeEach(() => {
  previous = process.env.PROXY_STATE_DIR;
  root = mkdtempSync(join(tmpdir(), "in-flight-"));
  process.env.PROXY_STATE_DIR = root;
  sharedThreadsInFlight();
  observer = new Database(inFlightPath());
});
afterEach(() => {
  observer.close();
  if (previous === undefined) delete process.env.PROXY_STATE_DIR;
  else process.env.PROXY_STATE_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

for (const retry of ["read", "mark"] as const) test(`failed unmarks are retried by the next ${retry} without losing overlapping turns`, () => {
  markThreadInFlight("thread", 1);
  markThreadInFlight("thread", 1);
  observer.exec("BEGIN IMMEDIATE");
  try {
    expect(() => markThreadInFlight("thread", -1)).toThrow();
    expect(() => markThreadInFlight("thread", -1)).toThrow();
  } finally { observer.exec("ROLLBACK"); }
  if (retry === "mark") markThreadInFlight("thread", 1);
  expect(sharedThreadsInFlight().has("thread")).toBe(retry === "mark");
  if (retry === "mark") {
    markThreadInFlight("thread", -1);
    expect(sharedThreadsInFlight().has("thread")).toBe(false);
  }
  expect(observer.query("SELECT * FROM threads_in_flight").all()).toHaveLength(0);
});

test("an unsuccessful delete rolls back the decrement before retry", () => {
  markThreadInFlight("thread", 1);
  observer.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON threads_in_flight
    BEGIN SELECT RAISE(ABORT, 'delete failed'); END`);
  expect(() => markThreadInFlight("thread", -1)).toThrow("delete failed");
  expect(observer.query("SELECT count FROM threads_in_flight").get()).toEqual({ count: 1 });
  observer.exec("DROP TRIGGER fail_delete");
  expect(sharedThreadsInFlight().has("thread")).toBe(false);
});

for (const pendingEnd of [false, true]) test(`a failed start survives contention${pendingEnd ? " with an owed end" : ""}`, () => {
  if (pendingEnd) markThreadInFlight("old", 1);
  observer.exec("BEGIN IMMEDIATE");
  try {
    if (pendingEnd) expect(() => markThreadInFlight("old", -1)).toThrow();
    expect(() => markThreadInFlight("new", 1)).toThrow();
  } finally { observer.exec("ROLLBACK"); }
  expect(sharedThreadsInFlight().get("new")).toEqual([process.pid]);
  expect(sharedThreadsInFlight().has("old")).toBe(false);
  markThreadInFlight("new", -1);
  expect(sharedThreadsInFlight().size).toBe(0);
});

test("reads apply pending starts and ends while the writer remains locked", () => {
  markThreadInFlight("finished", 1);
  markThreadInFlight("overlapping", 1);
  markThreadInFlight("overlapping", 1);
  observer.exec("BEGIN IMMEDIATE");
  try {
    expect(() => markThreadInFlight("finished", -1)).toThrow();
    expect(() => markThreadInFlight("overlapping", -1)).toThrow();
    expect(() => markThreadInFlight("new", 1)).toThrow();
    const busy = sharedThreadsInFlight();
    expect(busy.has("finished")).toBe(false);
    expect(busy.get("overlapping")).toEqual([process.pid]);
    expect(busy.get("new")).toEqual([process.pid]);
  } finally { observer.exec("ROLLBACK"); }
  expect(sharedThreadsInFlight().size).toBe(2);
  markThreadInFlight("overlapping", -1);
  markThreadInFlight("new", -1);
  expect(sharedThreadsInFlight().size).toBe(0);
});
