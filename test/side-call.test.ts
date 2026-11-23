import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SIDE_CALL_MARKER,
  SIDE_CALL_REFUSED_CODE,
  aliasHeaders,
  aliasMetadataHeader,
  aliasRequest,
  carriedTools,
  isSideCall,
  refusalBody,
  refusalFrame,
  refuseEnabled,
  sideCallCheck,
  wireModel,
} from "../src/side-call.mjs";
import { SIDE_CALL_MARKER as GATE_MARKER, isSidePrompt } from "../src/hygiene";
import type { ResponsesRequest } from "../src/types";

// q no-tools-code-mode (Nov 23). Shapes are what codex 0.163.0 and 0.171.0 sent a fake
// Responses endpoint for a no-tools side call on gpt-6.1-sol (code mode from its catalog
// entry): no `tools`, and exec and wait in an `additional_tools` input item.
const MARKED_DEV = { type: "message", role: "developer", content: [{ type: "input_text", text: `${SIDE_CALL_MARKER}\nYou produce a concise catch-up summary.` }] };
const USER = { type: "message", role: "user", content: [{ type: "input_text", text: "Produce the catch-up summary." }] };
const CODE_MODE = {
  type: "additional_tools",
  tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }, { type: "function", name: "wait" }] }],
};
const side = (extra: Record<string, unknown> = {}, input: unknown[] = [MARKED_DEV, USER]) => ({ model: "gpt-6.1-sol", input, ...extra });

describe("side-call marker", () => {
  test("the gate and the router use one marker and one test", () => {
    expect(GATE_MARKER).toBe(SIDE_CALL_MARKER);
    const cases = [
      side(),
      { model: "gpt-6.1-sol", instructions: `${SIDE_CALL_MARKER}\nbase`, input: [USER] },
      { model: "gpt-6.1-sol", instructions: SIDE_CALL_MARKER, input: [USER] },
      { model: "gpt-6.1-sol", input: [{ role: "system", content: `${SIDE_CALL_MARKER}\nx` }, USER] },
      { model: "gpt-6.1-sol", input: [USER, { ...USER, content: `${SIDE_CALL_MARKER}\nquoted by a user` }] },
      { model: "gpt-6.1-sol", input: [{ ...MARKED_DEV, content: [{ type: "input_text", text: `history\n${SIDE_CALL_MARKER}\n` }] }] },
      { model: "gpt-6.1-sol", instructions: ` ${SIDE_CALL_MARKER}\n`, input: [] },
      { model: "gpt-6.1-sol", input: [{ ...MARKED_DEV, type: "function_call_output" }] },
    ];
    expect(cases.map(isSideCall)).toEqual([true, true, true, true, false, false, false, false]);
    expect(cases.map((c) => isSidePrompt(c as ResponsesRequest))).toEqual(cases.map(isSideCall));
  });
  test("anything that is not a request is not a side call", () => {
    for (const value of [null, undefined, 1, "x", [], {}]) expect(isSideCall(value)).toBe(false);
  });
});

describe("carried tools", () => {
  test("code mode in additional_tools, plain tools, and empty namespaces all count", () => {
    expect(carriedTools(side({}, [MARKED_DEV, CODE_MODE, USER]))).toEqual(["functions.exec", "functions.wait"]);
    expect(carriedTools({ tools: [{ type: "custom", name: "apply_patch" }, { type: "web_search" }] })).toEqual(["apply_patch", "web_search"]);
    expect(carriedTools({ tools: [{ type: "namespace", name: "clock", tools: [] }] })).toEqual(["clock"]);
    expect(carriedTools({ input: [{ type: "additional_tools", tools: [] }] })).toEqual(["additional_tools"]);
    expect(carriedTools({ tools: [null] })).toEqual(["unnamed"]);
  });
  test("a request with no tools carries none", () => {
    expect(carriedTools(side())).toEqual([]);
    expect(carriedTools(side({ tools: [] }))).toEqual([]);
  });
});

describe("side-call check", () => {
  test("a side call with code mode is caught; refused only when asked", () => {
    const request = side({}, [MARKED_DEV, CODE_MODE, USER]);
    expect(sideCallCheck(request)).toEqual({ tools: ["functions.exec", "functions.wait"], refuse: false });
    expect(sideCallCheck(request, { refuse: true })).toEqual({ tools: ["functions.exec", "functions.wait"], refuse: true });
  });
  test("a tool-free side call and an unmarked chat with tools pass", () => {
    expect(sideCallCheck(side(), { refuse: true })).toBeNull();
    expect(sideCallCheck({ model: "gpt-6.1-sol", input: [USER, CODE_MODE] }, { refuse: true })).toBeNull();
  });
  test("the refusal names the tools and is an error, never a reply", () => {
    const body = refusalBody("gpt-6.1-sol", ["functions.exec", "functions.wait"]);
    expect(body.error.code).toBe(SIDE_CALL_REFUSED_CODE);
    expect(body.error.message).toContain("functions.exec, functions.wait");
    expect(body.error.message).toContain("No request was sent to the model");
    expect(refusalFrame("gpt-6.1-sol", ["x"])).toEqual({ type: "error", ...refusalBody("gpt-6.1-sol", ["x"]) });
    const many = refusalBody("m", Array.from({ length: 11 }, (_, i) => `t${i}`)).error.message;
    expect(many).toContain("t7, and 3 more");
  });
  test("refusing is off unless the flag file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "side-call-"));
    const flag = join(dir, "refuse");
    expect(refuseEnabled({ CODEX_ROUTER_SIDE_CALL_REFUSE_FILE: flag })).toBe(false);
    writeFileSync(flag, "");
    expect(refuseEnabled({ CODEX_ROUTER_SIDE_CALL_REFUSE_FILE: flag })).toBe(true);
    expect(refuseEnabled({}, () => { throw new Error("stat failed"); })).toBe(false);
  });
});

describe("side slug alias", () => {
  test("only the exact side slug is renamed", () => {
    expect(wireModel("gpt-6.1-sol-side")).toBe("gpt-6.1-sol");
    for (const m of ["gpt-6.1-sol", "gpt-6.1-sol-side2", "gpt-6.1-sol-sid", "x-gpt-6.1-sol-side", "gpt-6.2-sol-side", "toString", "__proto__", undefined, 3])
      expect(wireModel(m)).toBe(m);
  });
  test("requests keep their identity when nothing changes", () => {
    const plain = { model: "gpt-6.1-sol", input: [] };
    expect(aliasRequest(plain)).toBe(plain);
    const aliased = aliasRequest({ model: "gpt-6.1-sol-side", input: [USER] });
    expect(aliased).toEqual({ model: "gpt-6.1-sol", input: [USER] });
  });
  test("the turn-metadata header is renamed too, and only its model", () => {
    const header = JSON.stringify({ model: "gpt-6.1-sol-side", turn_id: "t1" });
    expect(JSON.parse(aliasMetadataHeader(header) as string)).toEqual({ model: "gpt-6.1-sol", turn_id: "t1" });
    expect(aliasMetadataHeader("not json")).toBe("not json");
    const same = JSON.stringify({ model: "gpt-6.1-sol" });
    expect(aliasMetadataHeader(same)).toBe(same);
    const headers = { "x-codex-turn-metadata": header, authorization: "Bearer fake" };
    expect(aliasHeaders(headers)).toEqual({ "x-codex-turn-metadata": JSON.stringify({ model: "gpt-6.1-sol", turn_id: "t1" }), authorization: "Bearer fake" });
    const untouched = { authorization: "Bearer fake" };
    expect(aliasHeaders(untouched)).toBe(untouched);
  });
});
