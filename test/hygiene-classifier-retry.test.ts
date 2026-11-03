import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLimitError, isLimited, listAccounts, markLimited, resetAccountState } from "../src/accounts";
import { claudeClassifier } from "../src/hygiene-proof";

// Nov 3, 13:31: the first account in order answered "You've hit your weekly limit" (is_error),
// wasn't marked limited, and every photo got "couldn't check the photo (classifier error)".
const saved = { ...process.env };
let root = "";
const spawn = Bun.spawn;

function setup(names: string[]) {
  root = mkdtempSync(join(tmpdir(), "classifier-retry-"));
  process.env.PROXY_STATE_DIR = join(root, "state");
  process.env.CLAUDE_CONFIG_DIR = join(root, "base");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  for (const name of names) {
    const dir = join(root, "state/accounts", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "oauth-token"), `fake-token-${name}`, { mode: 0o600 });
  }
  process.env.CLAUDE_ACCOUNT_ORDER = names.join(",");
  resetAccountState();
}

/** Each launch prints the next scripted stream-json lines and records the account's token. */
function script(replies: unknown[][]) {
  const tokens: string[] = [];
  (Bun as any).spawn = (_args: string[], options: any) => {
    tokens.push(options.env.CLAUDE_CODE_OAUTH_TOKEN);
    const lines = (replies.shift() ?? []).map((l) => JSON.stringify(l)).join("\n");
    return spawn([process.execPath, "-e", `process.stdin.resume();process.stdin.on("end",()=>{console.log(${JSON.stringify(lines)})})`], {
      ...options,
      env: { PATH: process.env.PATH },
    });
  };
  return tokens;
}

afterEach(() => {
  Bun.spawn = spawn;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetAccountState();
  if (root) rmSync(root, { recursive: true, force: true });
});

const image = { mediaType: "image/jpeg", bytes: Buffer.from("creatine tub") };
const limited = [{ type: "result", is_error: true, result: "You've hit your weekly limit · resets Nov 8, 4am" }];
const verdict = [
  { type: "result", is_error: false, structured_output: { kind: "creatine", confidence: 0.9, reason: "tub", reading: "" } },
];

test("the limit texts Claude Code prints, with or without the window, are limit errors", () => {
  for (const text of [
    "You have hit your limit",
    "You've hit your weekly limit · resets Nov 8, 4am",
    "You've hit your session limit",
    "You've hit your usage credit limit",
    "You've hit your monthly spend limit",
  ])
    expect(isLimitError(undefined, text)).toBe(true);
  expect(isLimitError(undefined, "API Error: 529 overloaded")).toBe(false);
  expect(isLimitError(undefined, "You've hit your fast limit")).toBe(false);
});

test("a limited account is marked and the next account classifies the photo", async () => {
  setup(["first", "second"]);
  const tokens = script([limited, verdict]);
  const v = await claudeClassifier(image, { kinds: ["creatine"] });
  expect(v.kind).toBe("creatine");
  expect(tokens).toEqual(["fake-token-first", "fake-token-second"]);
  expect(isLimited(listAccounts().find((a) => a.name === "first")!)).toBe(true);
  // The next photo goes straight to the account that works.
  const next = script([verdict]);
  expect((await claudeClassifier(image, { kinds: ["creatine"] })).kind).toBe("creatine");
  expect(next).toEqual(["fake-token-second"]);
});

test("an error that isn't a limit tries the next account without marking the first", async () => {
  setup(["first", "second"]);
  const tokens = script([[{ type: "result", is_error: true, result: "API Error: 529 overloaded" }], verdict]);
  expect((await claudeClassifier(image, { kinds: ["creatine"] })).kind).toBe("creatine");
  expect(tokens).toEqual(["fake-token-first", "fake-token-second"]);
  expect(isLimited(listAccounts().find((a) => a.name === "first")!)).toBe(false);
});

test("when every account fails, the error names the last reason", async () => {
  setup(["first", "second", "third", "fourth"]);
  const tokens = script([limited, [{ type: "system" }], [{ type: "result", is_error: true, result: "API Error: 500" }], verdict]);
  await expect(claudeClassifier(image, { kinds: ["creatine"] })).rejects.toThrow("API Error: 500");
  // Three tries at most, a fourth account is left alone.
  expect(tokens).toEqual(["fake-token-first", "fake-token-second", "fake-token-third"]);
});

test("a 429 status or a limit in errors[] marks the account; a rejected rate_limit_event too", async () => {
  setup(["first", "second", "third"]);
  script([
    [{ type: "result", is_error: true, api_error_status: 429, result: "Too many requests" }],
    [{ type: "result", is_error: true, result: "", errors: ["You've hit your weekly limit"] }],
    verdict,
  ]);
  expect((await claudeClassifier(image, { kinds: ["creatine"] })).kind).toBe("creatine");
  const limitedNow = (name: string) => isLimited(listAccounts().find((a) => a.name === name)!);
  expect([limitedNow("first"), limitedNow("second"), limitedNow("third")]).toEqual([true, true, false]);

  setup(["first", "second"]);
  const reset = Math.floor(Date.now() / 1000) + 3600;
  script([[{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset } }, ...limited], verdict]);
  await claudeClassifier(image, { kinds: ["creatine"] });
  expect(limitedNow("first")).toBe(true);
});

test("a launch that throws fails at once; limited accounts aren't retried", async () => {
  setup(["first", "second"]);
  let launches = 0;
  (Bun as any).spawn = () => {
    launches++;
    throw new Error("boundary stopped");
  };
  await expect(claudeClassifier(image, { kinds: ["creatine"] })).rejects.toThrow("boundary stopped");
  expect(launches).toBe(1);

  // Available accounts first; one already limited is skipped, not tried after the others.
  setup(["first", "second"]);
  markLimited(listAccounts().find((a) => a.name === "first")!);
  const tokens = script([[{ type: "result", is_error: true, result: "API Error: 500" }]]);
  await expect(claudeClassifier(image, { kinds: ["creatine"] })).rejects.toThrow();
  expect(tokens[0]).toBe("fake-token-second");
  expect(tokens).not.toContain("fake-token-first");
});
