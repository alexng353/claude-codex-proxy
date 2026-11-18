import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { noteThirdPerson, thirdPersonVerb } from "../src/native-tools";

// Synthetic replies with the openings seen on Nov 18; none is copied from a session.
test("third-person narration of the user is detected", () => {
  expect(thirdPersonVerb("Told Alex the real problem is the wrong tool.")).toBe("Told");
  expect(thirdPersonVerb("Giving Alex an honest status: blocked.")).toBe("Giving");
  expect(thirdPersonVerb("  Gave him the summary.")).toBe("Gave");
  expect(thirdPersonVerb("Asked the user for the code.")).toBe("Asked");
  expect(thirdPersonVerb("Pointed Alex at the log.")).toBe("Pointed");
  expect(thirdPersonVerb("Offered him two options.")).toBe("Offered");
});

test("first-person replies and other text are missed", () => {
  expect(thirdPersonVerb("I told Hinson the fix is live.")).toBeUndefined();
  expect(thirdPersonVerb("I told Alex the plan yesterday.")).toBeUndefined();
  expect(thirdPersonVerb("told Alex the plan")).toBeUndefined();
  expect(thirdPersonVerb("Told Alexander the plan")).toBeUndefined();
  expect(thirdPersonVerb("The worker started. Told Alex later.")).toBeUndefined();
  expect(thirdPersonVerb("")).toBeUndefined();
});

let logs: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logs = [];
  spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});
afterEach(() => spy.mockRestore());

test("noteThirdPerson logs only session id, verb and a running count", () => {
  expect(noteThirdPerson("I told Hinson.", "session-1")).toBeUndefined();
  expect(logs).toEqual([]);
  const first = noteThirdPerson("Told Alex the secret plan.", "session-1");
  const second = noteThirdPerson("Giving him the status.", "session-2");
  expect(first).toBe("Told");
  expect(second).toBe("Giving");
  expect(logs).toHaveLength(2);
  const [a, b] = logs.map((line) => JSON.parse(line).thirdPersonText);
  expect(a).toEqual({ sessionId: "session-1", verb: "Told", count: a.count });
  expect(b).toEqual({ sessionId: "session-2", verb: "Giving", count: a.count + 1 });
  expect(logs.join("\n")).not.toContain("secret plan");
  expect(logs.join("\n")).not.toContain("status");
});
