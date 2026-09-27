import { describe, expect, test } from "bun:test";
import { conversationDelta, prefixHash } from "../src/claude";
import type { ResponseInputItem } from "../src/types";

const assistant = (text: string): ResponseInputItem => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
const call = (id: string, type = "function_call"): ResponseInputItem => ({
  type,
  call_id: id,
  name: "exec_command",
  arguments: "{}",
});
const output = (id: string, type = "function_call_output"): ResponseInputItem => ({
  type,
  call_id: id,
  output: "ok",
});
const user = (text: string): ResponseInputItem => ({ role: "user", content: text });
const developer = (text: string): ResponseInputItem => ({ role: "developer", content: text });

describe("conversationDelta", () => {
  test("a new user message after a final answer continues the worker", () => {
    const delta = conversationDelta(
      [assistant("Done."), developer("time"), user("next")],
      { text: "Done.", callIds: new Set() },
    );
    expect(delta).toEqual([developer("time"), user("next")]);
  });

  test("interleaved parallel calls and outputs keep only the outputs", () => {
    const delta = conversationDelta(
      [assistant("Checking."), call("a"), output("a"), call("b"), output("b")],
      { text: "Checking.", callIds: new Set(["a", "b"]) },
    );
    expect(delta).toEqual([output("a"), output("b")]);
  });

  test("a tool search continues the worker with the loaded tools", () => {
    const loaded: ResponseInputItem = {
      type: "tool_search_output",
      call_id: "s",
      tools: [{ type: "function", name: "spawn_agent" }],
    };
    expect(
      conversationDelta([call("s", "tool_search_call"), loaded], {
        text: "",
        callIds: new Set(["s"]),
      }),
    ).toEqual([loaded]);
  });

  test("rejects histories that do not echo exactly the worker's answer", () => {
    const turn = { text: "Done.", callIds: new Set(["a"]) };
    // A call the worker never made.
    expect(conversationDelta([assistant("Done."), call("x"), output("x")], turn)).toBeUndefined();
    // Its own call missing.
    expect(conversationDelta([assistant("Done."), user("next")], turn)).toBeUndefined();
    // Different assistant text.
    expect(
      conversationDelta([assistant("Other."), call("a"), output("a")], turn),
    ).toBeUndefined();
    // Nothing new to send.
    expect(conversationDelta([assistant("Done."), call("a")], turn)).toBeUndefined();
  });
});

test("prefixHash ignores ids and statuses but not content", () => {
  const a = [user("hi"), { ...call("a"), id: "fc_1", status: "completed" }];
  const b = [user("hi"), call("a")];
  expect(prefixHash(a, 2)).toBe(prefixHash(b, 2));
  expect(prefixHash([user("hi!")], 1)).not.toBe(prefixHash([user("hi")], 1));
  expect(prefixHash([...b, user("more")], 2)).toBe(prefixHash(b, 2));
});
