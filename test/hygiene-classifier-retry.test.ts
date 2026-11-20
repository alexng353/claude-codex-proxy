import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLimitError, isLimited, listAccounts, markLimited, resetAccountState } from "../src/accounts";
import { claudeClassifier, needsSecondOpinion } from "../src/hygiene-proof";

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

/**
 * Each launch prints the next scripted stream-json lines and records the account's token. A
 * string reply is the child's own code instead.
 */
function script(replies: (unknown[] | string)[], models: string[] = []) {
  const tokens: string[] = [];
  (Bun as any).spawn = (args: string[], options: any) => {
    tokens.push(options.env.CLAUDE_CODE_OAUTH_TOKEN);
    models.push(args[args.indexOf("--model") + 1]);
    const reply = replies.shift() ?? [];
    const code =
      typeof reply === "string"
        ? reply
        : `process.stdin.resume();process.stdin.on("end",()=>{console.log(${JSON.stringify(reply.map((l) => JSON.stringify(l)).join("\n"))})})`;
    return spawn([process.execPath, "-e", code], {
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
  // The result itself isn't a limit text: only the event can mark the account.
  script([
    [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset } },
      { type: "result", is_error: true, result: "API Error: 500" },
    ],
    verdict,
  ]);
  await claudeClassifier(image, { kinds: ["creatine"] });
  expect(limitedNow("first")).toBe(true);
});

// Never answers and ignores SIGTERM, as a wedged CLI might.
const wedged = `process.on("SIGTERM",()=>{});process.stdin.resume();setInterval(()=>{},1000)`;

test("a try that times out moves to the next account", async () => {
  setup(["first", "second"]);
  process.env.HYGIENE_CLASSIFIER_TIMEOUT_MS = "300";
  const tokens = script([`process.stdin.resume();setInterval(()=>{},1000)`, verdict]);
  expect((await claudeClassifier(image, { kinds: ["creatine"] })).kind).toBe("creatine");
  expect(tokens).toEqual(["fake-token-first", "fake-token-second"]);
});

test("a child that ignores SIGTERM is killed and the call still ends", async () => {
  setup(["only"]);
  process.env.HYGIENE_CLASSIFIER_TIMEOUT_MS = "300";
  const tokens = script([wedged, verdict]);
  const started = Date.now();
  expect((await claudeClassifier(image, { kinds: ["creatine"] })).kind).toBe("creatine");
  // SIGTERM at 0.3 s, SIGKILL and give-up 2 s later, then the next account answers.
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(tokens[0]).toBe("fake-token-only");
  expect(tokens).toHaveLength(2);
}, 10_000);

test("a child that exits before reading its input is a retryable failure", async () => {
  setup(["first", "second"]);
  // A large image so the write can't all fit in the pipe before the child is gone.
  const big = { mediaType: "image/jpeg", bytes: Buffer.alloc(4 * 1024 * 1024, 7) };
  const tokens = script([`process.exit(1)`, verdict]);
  expect((await claudeClassifier(big, { kinds: ["creatine"] })).kind).toBe("creatine");
  expect(tokens).toEqual(["fake-token-first", "fake-token-second"]);
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

// Nov 19, slot 2026-11-20/morning-teeth: haiku refused a real teeth photo at 0.6 ("A man holds a
// white cylinder with a flat capped end near his lips, with no visible bristles") and Alex had to
// BYPASS. An unsure refusal now gets a second look from a stronger model.
const result = (kind: string, confidence: number, reason: string) => [
  { type: "result", is_error: false, structured_output: { kind, confidence, reason, reading: "" } },
];
const endOn = result("none", 0.6, "A man holds a white cylinder with a flat capped end near his lips, with no visible bristles.");

test("which verdicts get a second look: only refusals the model wasn't sure of", () => {
  const v = (kind: string, confidence: number) => ({ kind, confidence, reason: "" }) as any;
  expect(needsSecondOpinion(v("none", 0.6), ["teeth"])).toBe(true);
  expect(needsSecondOpinion(v("shower", 0.7), ["teeth"])).toBe(true);
  expect(needsSecondOpinion(v("teeth", 0.5), ["teeth"])).toBe(true);
  // A screenshot or an empty room is refused with certainty: no extra call.
  expect(needsSecondOpinion(v("none", 0.99), ["teeth"])).toBe(false);
  // An accepted photo is never asked again, so a second look can't make the gate stricter.
  expect(needsSecondOpinion(v("teeth", 0.97), ["teeth"])).toBe(false);
  expect(needsSecondOpinion(v("teeth", 0.6), ["teeth"])).toBe(false);
});

test("an unsure refusal of a brush seen end-on is asked again on the stronger model", async () => {
  setup(["first"]);
  const models: string[] = [];
  script([endOn, result("teeth", 0.9, "A toothbrush handle is held at his lips with its head in his mouth.")], models);
  const v = await claudeClassifier(image, { kinds: ["teeth"] });
  expect(v.kind).toBe("teeth");
  expect(v.reason).toContain("(second look)");
  expect(models).toEqual(["haiku", "sonnet"]);
});

test("a confident refusal costs one call; the second look can still refuse; its failure keeps the first verdict", async () => {
  setup(["first"]);
  const once: string[] = [];
  script([result("none", 0.99, "A screenshot of a Safari error page.")], once);
  expect((await claudeClassifier(image, { kinds: ["teeth"] })).kind).toBe("none");
  expect(once).toEqual(["haiku"]);

  const twice: string[] = [];
  script([endOn, result("none", 0.85, "He holds a white vape to his lips.")], twice);
  const refused = await claudeClassifier(image, { kinds: ["teeth"] });
  expect(refused.kind).toBe("none");
  expect(refused.reason).toContain("vape");
  expect(twice).toEqual(["haiku", "sonnet"]);

  // The stronger model erroring: the cheap verdict stands, nothing throws.
  const failing = [{ type: "result", is_error: true, result: "API Error: 500" }];
  script([endOn, failing]);
  const kept = await claudeClassifier(image, { kinds: ["teeth"] });
  expect(kept.kind).toBe("none");
  expect(kept.confidence).toBe(0.6);

  // A weigh-in is never credited on the second look's reading.
  const scale = [{ type: "result", is_error: false, structured_output: { kind: "weight", confidence: 0.8, reason: "scale", reading: "77.24 kg" } }];
  script([result("none", 0.5, "blurry display"), scale]);
  const weighed = await claudeClassifier(image, { kinds: ["weight"] });
  expect(weighed.kind).toBe("none");
  expect(weighed.reading).toBeUndefined();
});
