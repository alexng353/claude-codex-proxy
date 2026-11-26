import { describe, expect, test } from "bun:test";
import { createScrubber } from "../src/scrub.mjs";
import { createScrubber as createBaseScrubber } from "./fixtures/scrub-e55bfb3.mjs";

// Fakes are assembled at runtime so the source never holds a token-shaped
// literal for push protection or scanners to flag.
const repeat = (chars: string, length: number) =>
  Array.from({ length }, (_, index) => chars[index % chars.length]).join("");
const fill = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length));

const PEM = "-----" + "BEGIN";
const PEM_END = "-----" + "END";
const KNOWN: Array<[string, string]> = [
  ["CF_API_TOKEN", repeat("Zq9xW_k2", 40)],
  ["R2_SECRET_ACCESS_KEY", repeat("0a1b2c3d4e5f", 64)],
  ["PLAIN_VALUE", repeat("pQ7rS", 20)],
];
const scrubber = (create: typeof createScrubber) =>
  create({ files: ["/nonexistent/scrub-linear"], load: () => KNOWN, refreshMs: Infinity }).scrub;
const scrub = scrubber(createScrubber);
const baseScrub = scrubber(createBaseScrubber);

describe("the scrubber is linear on one long run", () => {
  // Units of a single run (no delimiter between repeats). The first seven are
  // the shapes named in q proxy-scrubber-linear; the credential-name units are
  // the ones that were quadratic (ASSIGNMENT re-scanned the word per keyword).
  const units = [
    "a", "A", "9", "aA9", "a-", "a/", "0123456789abcdef",
    "password", "token", "TOKEN", "secret", "_pat", "auth_key", "github_pat_", "my_api_key",
    `${PEM} PRIVATE KEY-----`, `${PEM} PRIVATE KEY-----C: x`, `${PEM} RSA PRIVATE KEY-----${PEM_END} DSA PRIVATE KEY-----`,
  ];
  // Wall-clock bounds, as scrub.test.ts already uses for 1 MB of history. Idle
  // Forge takes 1-35 ms here; the regressions they catch took 0.4-15 s.
  test.each(units)("200k of %j scrubs in under 200 ms", (unit) => {
    const text = fill(unit, 200_000);
    scrub(text.slice(0, 1000)); // warm up the JIT on this shape
    const t0 = performance.now();
    scrub(text);
    expect(Math.round(performance.now() - t0)).toBeLessThan(200);
  }, 120_000);

  // The truncated-PEM pattern backtracked exponentially on `Name: ` pairs
  // after a header: 92 characters took 0.86 s on e55bfb3, 3.3x per pair.
  test("a PEM header followed by many `a: ` pairs scrubs in under 200 ms", () => {
    const text = `${PEM} PRIVATE KEY-----\nA: ${"a: ".repeat(22)}!`;
    const t0 = performance.now();
    scrub(text);
    expect(Math.round(performance.now() - t0)).toBeLessThan(200);
    const long = `${PEM} PRIVATE KEY-----\nA: ${fill("a: ", 200_000)}!`;
    const t1 = performance.now();
    scrub(long);
    expect(Math.round(performance.now() - t1)).toBeLessThan(200);
  }, 120_000);

  // After one valid header the truncated-armor pass reads the rest of the text.
  // On 6d1e4d77 that cost a Map entry per line and four regex tests per
  // character: 1M newlines took 214 ms and +146 MiB, 1 MB of prose 60 ms
  // (18x the same prose without a header; e55bfb3 1.3x, now about 3x).
  const H = `${PEM} PRIVATE KEY-----`;
  // No known values, so the literal pass does not dilute the ratio below.
  const plain = createScrubber({ files: [] }).scrub;
  test("a header, 1M newlines and a body scrub in under 100 ms", () => {
    const text = `${H}${"\n".repeat(1_000_000)}${repeat("Ab3+/=", 16)}`;
    plain(text.slice(0, 2000));
    const t0 = performance.now();
    expect(plain(text)).toBe("[REDACTED:private-key]");
    expect(Math.round(performance.now() - t0)).toBeLessThan(100);
  });

  test("a header before 1 MB of prose costs under 8x the prose alone", () => {
    const prose = "The quick brown fox jumps over the lazy dog; see RFC 7468 for armor.\n".repeat(15_000);
    const timed = (text: string) => {
      let best = Infinity;
      for (let round = 0; round < 5; round++) {
        const t0 = performance.now();
        expect(plain(text)).toBe(text);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    const alone = timed(`see the docs\n${prose}`);
    const after = timed(`see ${H} in the docs\n${prose}`);
    expect(Math.round(after / Math.max(alone, 1))).toBeLessThan(8);
  });

  // Peak RSS of a child that scrubs one header, 4M newlines and a body: the
  // 6d1e4d77 pass added 548 MiB; e55bfb3 and this one stay under 1 MiB.
  test("a header and 4M newlines add under 64 MiB of peak memory", () => {
    const script = `
      const { createScrubber } = await import(${JSON.stringify(new URL("../src/scrub.mjs", import.meta.url).pathname)});
      const scrub = createScrubber({ files: [] }).scrub;
      const text = "-----" + "BEGIN PRIVATE KEY-----" + "\\n".repeat(4_000_000) + "Ab3+/=Ab3+/=Ab3+";
      scrub(text.slice(0, 2000));
      Bun.gc(true);
      const before = process.resourceUsage().maxRSS;
      if (scrub(text) !== "[REDACTED:private-key]") throw new Error("not redacted");
      console.log(Math.round((process.resourceUsage().maxRSS - before) / 1024));`;
    const child = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, SECRET_SCRUB_FILES: "" } });
    expect(child.exitCode).toBe(0);
    expect(Number(child.stdout.toString().trim())).toBeLessThan(64);
  }, 60_000);
});

// Real secret shapes the scrubber already catches, as fakes.
const B64 = repeat("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", 64);
const corpus = [
  `export GITHUB_TOKEN=${"gh" + "p_" + repeat("Ab3dE", 36)}`,
  `token ${"github" + "_pat_" + repeat("11ABCDEFG0", 82)} end`,
  `//registry.npmjs.org/:_authToken=${"np" + "m_" + repeat("aB3", 36)}`,
  `HF ${"h" + "f_" + repeat("Qw7", 34)}.`,
  `aws_access_key_id = ${"AK" + "IA" + repeat("Z7Q", 16)}`,
  `mailgun ${"ke" + "y-" + repeat("0123456789abcdef", 32)}`,
  `${repeat("0a1b2c3d", 32)}-${repeat("9f8e", 8)}-${repeat("7d6c", 8)}`,
  `ANTHROPIC ${"sk" + "-ant-api03-" + repeat("Xy9_-", 90)}`,
  `OPENAI "${"sk" + "-proj-" + repeat("Pq4", 48)}"`,
  `slack ${"xo" + "xb-" + repeat("1234-abcd", 30)}`,
  `${PEM} RSA PRIVATE KEY-----\n${B64.slice(0, 64)}\n${B64.slice(64, 128)}\n${PEM_END} RSA PRIVATE KEY-----\nafter`,
  `${PEM} OPENSSH PRIVATE KEY-----\n${B64.slice(0, 70)}\n(truncated)`,
  `${PEM} PGP PRIVATE KEY BLOCK-----\nComment: exported\nVersion: 1\n\n${B64.slice(0, 64)}\n${B64.slice(0, 40)}`,
  `${PEM} PRIVATE KEY-----\n${B64.slice(0, 64)}\n${PEM_END} PRIVATE KEY-----${PEM} PRIVATE KEY-----\n${B64.slice(0, 20)}`,
  `${PEM} EC PRIVATE KEY-----\n${B64.slice(0, 64)}\n${PEM_END} RSA PRIVATE KEY-----\n${PEM_END} EC PRIVATE KEY-----`,
  `+ export CF_API_TOKEN=${repeat("Zq9xW_k2", 40)}`,
  `{"AWS_SECRET_ACCESS_KEY": "${repeat("wJalrXUtnFEMI/K7MDENG/bPxRfiCY", 40)}"}`,
  `DB_PASSWORD: ${repeat("hunter2Q", 24)}`,
  `x_auth_key=${repeat("k9", 12)} MY_PAT=${repeat("Pat0", 20)} TOKEN=${repeat("t0", 10)}`,
  `FOO=BAR_TOKEN=${repeat("abc123", 24)}`,
  `CLAUDE_CODE_OAUTH_TOKEN=${"sk" + "-ant-oat01-" + repeat("Oa7_", 30)}`,
  `{"CLAUDE_CODE_OAUTH_TOKEN":"${repeat("Oa7-Z9+/", 40)}"}`,
  `known ${KNOWN[0][1]} and ${KNOWN[1][1]}; ${KNOWN[2][1]}`,
  // CRLF and Unicode whitespace: `\s` skips them, and only \n ends a header line.
  `${PEM} PRIVATE KEY-----\r\n${B64.slice(0, 64)}\r\n(cut)`,
  `${PEM} RSA PRIVATE KEY-----\r\n${B64.slice(0, 64)}\r\n${PEM_END} RSA PRIVATE KEY-----\r\nafter`,
  `${PEM} PGP PRIVATE KEY BLOCK-----\r\nComment: exported\r\nVersion: 1\r\n\r\n${B64.slice(0, 64)}\r\n${B64.slice(0, 40)}`,
  `${PEM} PRIVATE KEY-----\nA: x\r!${repeat("QUJDREVGR0hJSktM", 16)}\n!`,
  `${PEM} PRIVATE KEY----- ${B64.slice(0, 40)}`,
  `${PEM} PRIVATE KEY-----　${B64.slice(0, 40)}`,
];

// Near misses e55bfb3 leaves alone, each one edit away from a redaction.
const nearMisses = [
  // A dashed header name with a 16+ letter tail: the tail is not a body.
  `${PEM} PRIVATE KEY-----\nab-${repeat("Q", 16)}: !`,
  `${PEM} PRIVATE KEY-----\na-bcdefghijklmnopq: !`,
  // The label must end in PRIVATE KEY or PRIVATE KEY BLOCK.
  `${PEM} PRIVATE KEY BLOCK X-----\n${B64.slice(0, 64)}\n${PEM_END} PRIVATE KEY BLOCK X-----`,
  `${PEM} PUBLIC KEY-----\n${B64.slice(0, 64)}`,
  // A header value ends at its own line; a body on the next line is not its.
  `${PEM} PRIVATE KEY-----A: \n_${repeat("ABCDEFGHIJKLMNOP", 16)}`,
  // 15 base64 characters are not a body.
  `${PEM} PRIVATE KEY-----${repeat("ABCDEFGHIJKLMNOP", 15)}`,
  // A header name starts with a letter, so neither `-: ` nor `-a: ` is one.
  `${PEM} PRIVATE KEY------: ${repeat("ABCDEFGHIJKLMNOP", 16)}`,
  `${PEM} PRIVATE KEY------a: ${repeat("ABCDEFGHIJKLMNOP", 16)}`,
  "max_tokens: unlimited",
  "const tokenCount = 12345678901234;",
  "TOKEN_URL=https://example.com/oauth/token",
];

describe("redaction is byte-identical to the e55bfb3 scrubber", () => {
  test.each(corpus.map((text, index) => [index, text]))("corpus %d", (_, text) => {
    const out = scrub(text as string);
    expect(out).toContain("[REDACTED");
    expect(out).toBe(baseScrub(text as string));
  });

  test.each(nearMisses.map((text, index) => [index, text]))("near miss %d is left alone, as before", (_, text) => {
    expect(baseScrub(text as string)).toBe(text as string);
    expect(scrub(text as string)).toBe(text as string);
  });

  // Every UTF-16 code unit between a header and a body, and inside a header
  // line: whitespace and line ends are no longer the regex engine's, so check
  // the hand-written classes against it.
  test("every code unit after a header is skipped or not as before", () => {
    const diffs: string[] = [];
    for (let unit = 0; unit < 0x10000; unit++) {
      const c = String.fromCharCode(unit);
      for (const text of [`${PEM} PRIVATE KEY-----${c}${B64.slice(0, 20)}`, `${PEM} PRIVATE KEY-----\nA: x${c}${B64.slice(0, 20)}\n!`])
        if (scrub(text) !== baseScrub(text)) diffs.push(unit.toString(16));
    }
    expect(diffs).toEqual([]);
  }, 120_000);

  // Random strings over the pieces every rewritten pattern keys on: credential
  // names, separators, quotes, PEM armor and header lines, base64 runs.
  test("random strings over the patterns' own pieces", () => {
    const pieces = [
      "a", "Z", "9", "_", "-", "/", "+", "=", ":", ": ", " ", "\t", "\n", "\"", "'", "$", "`", ",", ".", ")",
      "password", "TOKEN", "_pat", "Secret", "api_key", "MY_TOKEN", "x_auth_key", "AUTH_KEY",
      PEM + " ", PEM_END + " ", "PRIVATE KEY", "RSA ", " BLOCK", "-----", "PRIVATE KEY-----",
      `${PEM} PRIVATE KEY-----`, `${PEM_END} PRIVATE KEY-----`, `${PEM} RSA PRIVATE KEY-----`, `${PEM_END} RSA PRIVATE KEY-----`,
      "Comment: ", "A: ", "a-b: ", "\nVersion: 1\n", "ABCDEFGHIJKLMNOP", "0123456789abcdef", "QRSTUVWX", "abc123def456ghi7",
      "\r", "\r\n", " ", "　", " ", "\v", "\f", "a-bcdefghijklmnopq: ", "PRIVATE KEY BLOCK X-----", "PUBLIC KEY-----",
    ];
    let seed = 0x5eed;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const diffs: string[] = [];
    for (let index = 0; index < 20_000 && diffs.length < 5; index++) {
      const length = 1 + Math.floor(next() * 28);
      let text = "";
      for (let piece = 0; piece < length; piece++) text += pieces[Math.floor(next() * pieces.length)];
      if (scrub(text) !== baseScrub(text)) diffs.push(JSON.stringify(text));
    }
    expect(diffs).toEqual([]);
  }, 120_000);
});
