import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createScrubber, isSecretValue, loadSecretFile } from "../src/scrub.mjs";

// Fakes are assembled at runtime so the source never holds a token-shaped
// literal for push protection or scanners to flag.
const repeat = (chars: string, length: number) =>
  Array.from({ length }, (_, index) => chars[index % chars.length]).join("");
const FAKE_GH = "gh" + "p_" + repeat("Ab3dE", 36);
const FAKE_CF = repeat("Zq9xW_k2", 40);
const FAKE_R2_SECRET = repeat("0a1b2c3d4e5f", 64);
const FAKE_MG = "ke" + "y-" + repeat("0123456789abcdef", 32);

let directory = "";
let shellFile = "";
let dotenvFile = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "scrub-test-"));
  shellFile = join(directory, "secrets.zsh");
  dotenvFile = join(directory, "service.env");
  await writeFile(
    shellFile,
    [
      `export GITHUB_TOKEN=${FAKE_GH}`,
      `export GH_NPM_TOKEN=$GITHUB_TOKEN`,
      `export CF_API_TOKEN="${FAKE_CF}"`,
      `export SHORT=abc`,
      "set -x",
      'echo "noise that must not break loading"',
    ].join("\n"),
  );
  await writeFile(
    dotenvFile,
    [
      `CLOUDFLARE_R2_SECRET_ACCESS_KEY='${FAKE_R2_SECRET}'`,
      "PORT=8080",
      "DATA_DIR=/home/someone/.local/share/thing-with-a-long-path",
    ].join("\n"),
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("loading", () => {
  test("sources shell files and resolves derived values", () => {
    const vars = loadSecretFile(shellFile);
    expect(vars.get("GITHUB_TOKEN")).toBe(FAKE_GH);
    expect(vars.get("GH_NPM_TOKEN")).toBe(FAKE_GH);
    expect(vars.get("CF_API_TOKEN")).toBe(FAKE_CF);
    expect(vars.has("HOME")).toBe(false);
  });

  test("parses dotenv files", () => {
    expect(loadSecretFile(dotenvFile).get("CLOUDFLARE_R2_SECRET_ACCESS_KEY")).toBe(
      FAKE_R2_SECRET,
    );
  });

  test("missing files are empty", () => {
    expect(loadSecretFile(join(directory, "absent.zsh")).size).toBe(0);
  });

  test("keeps ordinary config readable", () => {
    expect(isSecretValue("PORT", "8080")).toBe(false);
    expect(isSecretValue("DATA_DIR", "/home/someone/.local/share/thing")).toBe(false);
    expect(isSecretValue("SHORT", "abc")).toBe(false);
    expect(isSecretValue("MG_API_KEY", FAKE_MG)).toBe(true);
  });
});

describe("scrubbing", () => {
  const scrubber = () => createScrubber({ files: [shellFile, dotenvFile] });

  test("replaces known values with their names, including xtrace lines", () => {
    const trace = [
      `+/home/a/.config/zsh/secrets.zsh:1> export GITHUB_TOKEN=${FAKE_GH}`,
      `+/home/a/.config/zsh/secrets.zsh:3> export CF_API_TOKEN=${FAKE_CF}`,
      `aws s3 ls --secret ${FAKE_R2_SECRET}`,
    ].join("\n");
    const out = scrubber().scrub(trace);
    for (const value of [FAKE_GH, FAKE_CF, FAKE_R2_SECRET]) expect(out).not.toContain(value);
    expect(out).toContain("[REDACTED:GH_NPM_TOKEN|GITHUB_TOKEN]");
    expect(out).toContain("[REDACTED:CF_API_TOKEN]");
    expect(out).toContain("[REDACTED:CLOUDFLARE_R2_SECRET_ACCESS_KEY]");
  });

  test("redacts token shapes that are not configured", () => {
    const s = createScrubber({ files: [] });
    const samples = {
      github: "github" + "_pat_" + repeat("A1b2C3", 60),
      npm: "np" + "m_" + repeat("x9Y8z7", 36),
      hf: "h" + "f_" + repeat("Q1w2E3", 34),
      aws: "AK" + "IA" + repeat("ABCDEFG234567", 16),
      mailgun: FAKE_MG,
      cloudflare: `CLOUDFLARE_API_TOKEN=${repeat("r4T5y6_U", 40)}`,
      json: `{"aws_secret_access_key": "${repeat("wJalr9XUtn", 40)}"}`,
      pem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${repeat("b3BlbnNzaC1rZXk", 70)}\n-----END OPENSSH PRIVATE KEY-----`,
      truncatedPem: `-----BEGIN RSA PRIVATE KEY-----\n${repeat("MIIEpAIBAAKCAQEA", 64)}`,
    };
    for (const [kind, sample] of Object.entries(samples)) {
      const out = s.scrub(`before ${sample} after`);
      expect(out, kind).toContain("[REDACTED:");
      expect(out, kind).toContain("before ");
      expect(out, kind).toContain(" after");
      expect(out, kind).not.toContain(sample.slice(-12));
    }
  });

  test("leaves ordinary text alone", () => {
    const s = createScrubber({ files: [] });
    const text = [
      "max_tokens: unlimited",
      "commit 0bae7f5 perf: reuse Claude process across tool calls",
      "sha256:4d8799d3ca0e642c0c8079063f1c0214a71e47039bdd8a3d82f90f1fdeba06fa",
      "GITHUB_TOKEN=$GITHUB_TOKEN",
      "See https://github.com/alexng353/claude-codex-proxy/pull/12",
    ].join("\n");
    expect(s.scrub(text)).toBe(text);
  });

  test("walks requests copy-on-write and skips opaque fields", () => {
    const s = scrubber();
    const clean = { model: "m", input: [{ type: "message", content: "hi there friend" }] };
    expect(s.scrubRequest(clean)).toBe(clean);
    const image = `data:image/png;base64,${FAKE_GH}`;
    const request = {
      model: "m",
      instructions: `token ${FAKE_GH}`,
      input: [
        { type: "function_call", arguments: JSON.stringify({ cmd: `curl -H 'Authorization: ${FAKE_CF}'` }) },
        { type: "function_call_output", output: [{ type: "input_text", text: FAKE_R2_SECRET }] },
        { type: "message", content: [{ type: "input_image", image_url: image }] },
        { type: "compaction", encrypted_content: FAKE_GH },
      ],
      tools: [{ type: "function", description: FAKE_GH }],
    };
    const before = JSON.stringify(request);
    const out = s.scrubRequest(request);
    expect(JSON.stringify(request)).toBe(before);
    const sent = JSON.stringify({ ...out, tools: [] });
    expect(out.input[2]).toBe(request.input[2]);
    expect(out.input[3]).toBe(request.input[3]);
    expect(sent).not.toContain(FAKE_CF);
    expect(sent).not.toContain(FAKE_R2_SECRET);
    expect(out.instructions).toBe("token [REDACTED:GH_NPM_TOKEN|GITHUB_TOKEN]");
  });

  test("picks up rotated values and keeps retired ones", () => {
    const file = join(directory, "rotating.env");
    writeFileSync(file, "SERVICE_API_TOKEN=first-Value-123456\n");
    let clock = 0;
    let loads = 0;
    const s = createScrubber({
      files: [file],
      refreshMs: 1000,
      now: () => clock,
      load: (path) => {
        loads++;
        return loadSecretFile(path);
      },
    });
    expect(s.scrub("x first-Value-123456")).toBe("x [REDACTED:SERVICE_API_TOKEN]");
    // An unchanged file is not reloaded, even after the interval.
    clock = 5000;
    s.scrub("nothing to see here");
    expect(loads).toBe(1);
    writeFileSync(file, "SERVICE_API_TOKEN=second-Value-6543210\n");
    // Inside the interval the change is not yet seen.
    clock = 5500;
    expect(s.scrub("y second-Value-6543210")).toContain("second-Value");
    clock = 7000;
    expect(s.scrub("y second-Value-6543210")).toBe("y [REDACTED:SERVICE_API_TOKEN]");
    expect(s.scrub("x first-Value-123456")).toBe("x [REDACTED:SERVICE_API_TOKEN]");
    expect(s.names()).toEqual(["SERVICE_API_TOKEN"]);
  });

  test("adds negligible latency on a large request", () => {
    const s = scrubber();
    const chunk = "ordinary tool output line with paths /usr/lib and numbers 12345\n";
    const input = Array.from({ length: 400 }, (_, index) => ({
      type: "function_call_output",
      call_id: `call_${index}`,
      output: chunk.repeat(40),
    }));
    const request = { model: "m", input };
    s.scrubRequest(request);
    const started = performance.now();
    const out = s.scrubRequest(request);
    const elapsed = performance.now() - started;
    expect(out).toBe(request);
    // About 1 MB of history.
    expect(elapsed).toBeLessThan(100);
  });
});
