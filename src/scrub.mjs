/**
 * Redact credentials from model-bound requests.
 *
 * Shell tracing and environment dumps can put real tokens into tool output,
 * and every later turn replays that output to the model. The scrubber removes
 * known values (read in memory from the configured env files) and common
 * token shapes before a request leaves this machine. It is plain JS so the
 * Node model router can import it next to context.mjs.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SPLIT = "\0__SCRUB_SPLIT__\0";
const MIN_VALUE_LENGTH = 8;
const SECRET_NAME =
  /(TOKEN|SECRET|PASSW(OR)?D|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SIGNING_?KEY|_PAT$|^PAT$|^KEY$|AUTH|CREDENTIAL|CLIENT_ID|ENDPOINT|DSN)/i;

/**
 * Keys in JSON/YAML/TOML credential files whose string values are secrets.
 * Matched on the lowercased key with separators removed, anchored at the end
 * so neighbours such as `tokenExpiresAt` or `token_type` stay out.
 */
const CREDENTIAL_KEY =
  /(?:token|secret|password|passwd|passphrase|apikey|accesskey|secretkey|privatekey|authkey|signingkey|credential)$|^(?:key|pat)$/;

/** Token shapes that are secrets wherever they appear. */
const PATTERNS = [
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,251})\b/g, "github-token"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "npm-token"],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, "huggingface-token"],
  [/\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, "aws-access-key-id"],
  [/\bkey-[0-9a-f]{32}\b/g, "mailgun-key"],
  [/\b[0-9a-f]{32}-[0-9a-f]{8}-[0-9a-f]{8}\b/g, "mailgun-key"],
  [/\bsk-(?:ant-[a-z0-9]+-|proj-)?[A-Za-z0-9_-]{32,}\b/g, "api-key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "slack-token"],
];

/**
 * `NAME=value`, `NAME: value` and `"NAME": "value"` where NAME looks like a
 * credential. This is what `set -x` prints for `export CF_API_TOKEN=...`, and
 * it covers prefixless tokens such as Cloudflare API tokens and R2/AWS
 * secret keys. The value must mix letters and digits so prose such as
 * `max_tokens: unlimited` is left alone.
 *
 * NAME is a whole word (the separator starts with a non-word character) with
 * a keyword after its first character. The lookahead checks the keyword
 * before NAME is matched: written as `[A-Za-z0-9_]*(?:TOKEN|...)[A-Za-z0-9_]*`
 * the regex backtracked through the word once per keyword in it, quadratic on
 * one long run (200k of `password`: 7.6 s on e55bfb3).
 */
const ASSIGNMENT =
  /\b(?=[A-Za-z_][A-Za-z0-9_]*?(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|_PAT|AUTH_KEY))([A-Za-z_][A-Za-z0-9_]*)(["']?\s*[=:]\s*["']?)([^\s"'`$\\,;)}\]]{12,})/gi;

const PRIVATE_KEY_MARKER = "[REDACTED:private-key]";
const ARMOR_LABEL = /[A-Z0-9 ]*/y;

/**
 * `-----BEGIN <label>-----` or `-----END <label>-----` at `at`, where the label
 * is `[A-Z0-9 ]*PRIVATE KEY` with an optional ` BLOCK`. The label runs to the
 * first character outside `[A-Z0-9 ]`, so it is the only one that can match.
 */
function armorLine(text, at, word) {
  const from = at + word.length;
  ARMOR_LABEL.lastIndex = from;
  ARMOR_LABEL.exec(text);
  const to = ARMOR_LABEL.lastIndex;
  const label = text.slice(from, to);
  if (!text.startsWith("-----", to)) return null;
  if (!label.endsWith("PRIVATE KEY") && !label.endsWith("PRIVATE KEY BLOCK")) return null;
  return { label, end: to + 5 };
}

/**
 * Whole armored private keys: each BEGIN through the first END with the same
 * label. Same result as
 * /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END \1PRIVATE KEY\2-----/g,
 * whose lazy body re-read the rest of the text for every unclosed BEGIN.
 */
function redactArmoredKeys(text) {
  if (!text.includes("-----BEGIN ")) return text;
  const ends = new Map();
  for (let at = text.indexOf("-----END "); at >= 0; at = text.indexOf("-----END ", at + 1)) {
    const line = armorLine(text, at, "-----END ");
    if (!line) continue;
    if (!ends.has(line.label)) ends.set(line.label, { next: 0, at: [] });
    ends.get(line.label).at.push([at, line.end]);
  }
  let out = "", copied = 0;
  for (let at = text.indexOf("-----BEGIN "); at >= 0;) {
    const line = armorLine(text, at, "-----BEGIN ");
    const closing = line && ends.get(line.label);
    if (closing) {
      // BEGINs are visited left to right, so the first END at or after each
      // one only moves forward.
      while (closing.next < closing.at.length && closing.at[closing.next][0] < line.end) closing.next++;
      if (closing.next < closing.at.length) {
        out += text.slice(copied, at) + PRIVATE_KEY_MARKER;
        copied = closing.at[closing.next][1];
        at = text.indexOf("-----BEGIN ", copied);
        continue;
      }
    }
    at = text.indexOf("-----BEGIN ", at + 1);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

const isSpace = (c) => /\s/.test(c);
const isLetter = (c) => /[A-Za-z]/.test(c);
const isLetterOrDash = (c) => /[A-Za-z-]/.test(c);
const isBase64 = (c) => /[A-Za-z0-9+/=]/.test(c);

/**
 * A truncated PEM or PGP armor block still leaks its body. PGP armor may open
 * with `Comment: ...` style header lines. Same result as
 * /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:\s*[A-Za-z][A-Za-z-]*: [^\n]*)*(?:\s*[A-Za-z0-9+/=]{16,})+/g,
 * which backtracked exponentially over `a: a: a: ...` after a header.
 *
 * That regex, after a header ending at p, tries header lines first: skip
 * whitespace, `Name: `, then the rest of the line from its longest to its
 * shortest, recursing at each end r; only when none succeeds does it try the
 * body at p. So from any position r the outcome is fixed:
 *   at(r) = the outcome at the rightmost success R in [q, end of q's line],
 *           where q follows `Name: ` after r, if there is one;
 *           otherwise body(r): skip whitespace, a run of 16+ base64
 *           characters, and every following such run (the match end), or none.
 * One right-to-left pass computes it for every position.
 */
function redactTruncatedArmor(text) {
  if (!text.includes("-----BEGIN ")) return text;
  const headers = [];
  for (let at = text.indexOf("-----BEGIN "); at >= 0; at = text.indexOf("-----BEGIN ", at + 1)) {
    const line = armorLine(text, at, "-----BEGIN ");
    if (line) headers.push([at, line.end]);
  }
  if (headers.length === 0) return text;
  const n = text.length;
  const base = headers[0][1];
  const size = n - base + 1;
  const body = new Int32Array(size); // match end of body(r), or -1
  const lineEnd = new Int32Array(size);
  const outcome = new Map(); // header end -> match end, or -1
  const wanted = new Set(headers.map(([, end]) => end));
  const rightmost = new Map(); // line end -> outcome at the rightmost success on that line
  let eol = n, run = n, word = n, next = n, nextRun = n, nextWord = n;
  for (let r = n; r >= base; r--) {
    const c = r < n ? text[r] : "";
    if (r === n || c === "\n") eol = r;
    run = r < n && isBase64(c) ? run : r;
    word = r < n && isLetterOrDash(c) ? word : r;
    if (r === n || !isSpace(c)) {
      next = r;
      nextRun = run;
      nextWord = word;
    }
    lineEnd[r - base] = eol;
    body[r - base] = nextRun - next >= 16 ? (nextRun < n && body[nextRun - base] >= 0 ? body[nextRun - base] : nextRun) : -1;
    let result = body[r - base];
    if (next < n && isLetter(text[next]) && text[nextWord] === ":" && text[nextWord + 1] === " ") {
      const q = nextWord + 2;
      const hit = rightmost.get(q <= n ? lineEnd[q - base] : -1);
      if (hit && hit.at >= q) result = hit.end;
    }
    if (result >= 0 && !rightmost.has(eol)) rightmost.set(eol, { at: r, end: result });
    if (wanted.has(r)) outcome.set(r, result);
  }
  let out = "", copied = 0;
  for (const [at, end] of headers) {
    if (at < copied) continue;
    const stop = outcome.get(end);
    if (stop < 0) continue;
    out += text.slice(copied, at) + PRIVATE_KEY_MARKER;
    copied = stop;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

// OAuth assignments occur in shell traces, JSON and JSON serialized inside JSON.
// Parse the value as one word so redaction cannot consume code or leave a tail.
const OAUTH_NAME = "CLAUDE_CODE_OAUTH_TOKEN";
const OAUTH_MARKER = `[REDACTED:${OAUTH_NAME}]`;
function isOAuthToken(value) {
  return value.length >= 16 && /^[A-Za-z0-9_+/=-]+$/.test(value)
    && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}
function oauthWord(text, start) {
  if (text.startsWith('\\"', start)) {
    const end = text.indexOf('\\"', start + 2);
    if (end < 0 || /[\r\n]/.test(text.slice(start, end))) return null;
    try {
      const value = JSON.parse(JSON.parse(`"${text.slice(start, end + 2)}"`));
      return { value, end: end + 2, quote: '\\"' };
    } catch { return null; }
  }
  let at = start, value = "", quote = "";
  while (at < text.length && !/[\s,;)}\]]/.test(text[at])) {
    const c = text[at];
    if (c === '"' || c === "'") {
      if (at === start) quote = c;
      const begin = at++;
      let part = "";
      while (at < text.length && text[at] !== c) {
        if (/[\r\n]/.test(text[at])) return null;
        if (c === '"' && text[at] === "\\") {
          if (at + 1 >= text.length || /[\r\n]/.test(text[at + 1])) return null;
          part += text.slice(at, at + 2); at += 2;
        } else part += text[at++];
      }
      if (text[at] !== c) return null;
      at++;
      if (c === '"') {
        try { part = JSON.parse(text.slice(begin, at)); } catch { return null; }
      }
      value += part;
    } else {
      // Expressions and property access are deliberately not token literals.
      if (c === '$' || c === '`' || c === '(') return null;
      if (c === "\\") {
        if (at + 1 >= text.length || /[\r\n]/.test(text[at + 1])) return null;
        value += text[at + 1]; at += 2;
      } else value += text[at++];
    }
  }
  return { value, end: at, quote };
}
function scrubOAuthAssignments(text) {
  const assignment = /\bCLAUDE_CODE_OAUTH_TOKEN(?:\\?["'])?[ \t]*[=:][ \t]*/g;
  let out = "", copied = 0;
  for (let match; (match = assignment.exec(text));) {
    const start = assignment.lastIndex;
    const word = oauthWord(text, start);
    if (!word || !isOAuthToken(word.value)) continue;
    out += text.slice(copied, start) + word.quote + OAUTH_MARKER + word.quote;
    copied = word.end;
    assignment.lastIndex = word.end;
  }
  return out + text.slice(copied);
}

function looksLikeToken(value) {
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value) && !value.startsWith("[REDACTED");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseEnvBlock(block) {
  const vars = new Map();
  for (const entry of block.split("\0")) {
    const index = entry.indexOf("=");
    if (index > 0) vars.set(entry.slice(0, index), entry.slice(index + 1));
  }
  return vars;
}

/**
 * Source a shell env file in a clean zsh and return only the variables it
 * set. Sourcing (rather than parsing) resolves values assigned from other
 * variables. Tracing is forced off and output discarded so values never
 * reach a log. The values exist only in this process's memory.
 */
function loadShellFile(file) {
  const script = [
    "unsetopt xtrace verbose 2>/dev/null",
    "env -0",
    "print -rn -- $'\\0__SCRUB_SPLIT__\\0'",
    'source "$1" >/dev/null 2>&1 </dev/null',
    "env -0",
  ].join("\n");
  const result = spawnSync("zsh", ["-f", "-c", script, "zsh", file], {
    encoding: "utf8",
    env: { HOME: homedir(), PATH: "/usr/local/bin:/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return new Map();
  const at = result.stdout.indexOf(SPLIT);
  if (at < 0) return new Map();
  const before = parseEnvBlock(result.stdout.slice(0, at));
  const after = parseEnvBlock(result.stdout.slice(at + SPLIT.length));
  const added = new Map();
  for (const [name, value] of after)
    if (before.get(name) !== value && name !== "_") added.set(name, value);
  return added;
}

/** systemd EnvironmentFile / dotenv syntax: KEY=VALUE with optional quotes. */
function loadDotenvFile(file) {
  const vars = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    vars.set(match[1], value);
  }
  return vars;
}

/**
 * `# export NAME=value` lines in a shell file. A credential that was disabled
 * by commenting it out is still a credential until it is revoked, and copies
 * of it may sit in old transcripts or shell snapshots. Literal values only.
 */
function commentedExports(file) {
  const entries = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*#+\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=("[^"$`\\]*"|'[^']*'|[^\s"'$`\\]+)\s*$/.exec(line);
    if (match) entries.push([match[1], unquote(match[2])]);
  }
  return entries;
}

function unquote(value) {
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(value)) return value.slice(1, -1);
  return value;
}

function isCredentialKey(key) {
  return CREDENTIAL_KEY.test(String(key).toLowerCase().replace(/[^a-z0-9]/g, ""));
}

/** Credential leaves of a parsed JSON document, keyed by their leaf name. */
export function credentialEntriesFromJson(text) {
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = [];
  const walk = (value, key) => {
    if (typeof value === "string") {
      if (key != null && isCredentialKey(key)) entries.push([key, value]);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
    } else if (value && typeof value === "object") {
      for (const [name, child] of Object.entries(value)) walk(child, name);
    }
  };
  walk(root, null);
  return entries;
}

/**
 * Credential `key: value` pairs from YAML such as gh's hosts.yml. This is a
 * line scanner, not a YAML parser: it reads scalar values on the key's own
 * line, which is how CLI tools write tokens.
 */
export function credentialEntriesFromYaml(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:-\s+)?(["']?)([A-Za-z0-9_.-]+)\1\s*:\s+(.+?)\s*$/.exec(line);
    if (!match || !isCredentialKey(match[2])) continue;
    const quoted = /^("(?:[^"\\]|\\.)*"|'[^']*')/.exec(match[3]);
    const value = quoted ? unquote(quoted[1]) : match[3].replace(/\s+#.*$/, "");
    entries.push([match[2], value]);
  }
  return entries;
}

/** Credential `key = "value"` pairs from TOML such as wrangler's config. */
export function credentialEntriesFromToml(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(["']?)([A-Za-z0-9_.-]+)\1\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/.exec(line);
    if (!match || !isCredentialKey(match[2])) continue;
    entries.push([match[2], unquote(match[3])]);
  }
  return entries;
}

/**
 * Armored private key files (envx keys, exported GPG subkeys). Each body line
 * becomes a literal, so a fragment such as `head -5 private.key` is redacted
 * even without the BEGIN line the token patterns key on. Public keys and
 * anything else yield nothing.
 */
export function credentialEntriesFromKeyFile(text) {
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(text)) {
    // A bare API key file (`~/.config/today/abliteration.key`, alex-0229): one
    // token on one line is that secret.
    const value = text.trim();
    return value.length >= 16 && /^[\x21-\x7e]+$/.test(value) ? [["API_KEY", value]] : [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    const body = line.trim();
    if (body.length >= 40 && /^[A-Za-z0-9+/=]+$/.test(body)) entries.push(["PRIVATE_KEY", body]);
  }
  return entries;
}

/** All `[name, value]` pairs a credential file holds. Names may repeat. */
export function loadSecretEntries(file) {
  try {
    if (!statSync(file).isFile()) return [];
  } catch {
    return [];
  }
  try {
    if (file.endsWith("/oauth-token")) {
      const value = readFileSync(file, "utf8").trim();
      return value ? [[OAUTH_NAME, value]] : [];
    }
    if (/\.(zsh|sh|bash)$/.test(file)) return [...loadShellFile(file), ...commentedExports(file)];
    if (/\.(json|toml|ya?ml|key|asc|pem)$/.test(file)) {
      const text = readFileSync(file, "utf8");
      if (file.endsWith(".json")) return credentialEntriesFromJson(text);
      if (file.endsWith(".toml")) return credentialEntriesFromToml(text);
      if (/\.ya?ml$/.test(file)) return credentialEntriesFromYaml(text);
      return credentialEntriesFromKeyFile(text);
    }
    return [...loadDotenvFile(file)];
  } catch {
    return [];
  }
}

/** Name -> value view of a credential file; the last value wins on repeats. */
export function loadSecretFile(file) {
  try {
    statSync(file);
  } catch {
    return new Map();
  }
  return new Map(loadSecretEntries(file));
}

/**
 * Expand `*` path segments (`accounts/*\/.credentials.json`). Missing
 * directories expand to nothing, so files that do not exist yet are harmless.
 */
export function expandSecretPaths(patterns) {
  const out = [];
  const expand = (base, segments) => {
    if (segments.length === 0) return out.push(base);
    const [segment, ...rest] = segments;
    if (!segment.includes("*")) return expand(join(base, segment), rest);
    const matcher = new RegExp(`^${segment.split("*").map(escapeRegExp).join(".*")}$`);
    let names = [];
    try {
      names = readdirSync(base).sort();
    } catch {
      return;
    }
    for (const name of names) if (matcher.test(name)) expand(join(base, name), rest);
  };
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      out.push(pattern);
      continue;
    }
    const absolute = pattern.startsWith("/");
    expand(absolute ? "/" : "", pattern.split("/").filter(Boolean));
  }
  return out;
}

/** Whether a configured value is worth redacting by its literal text. */
export function isSecretValue(name, value) {
  if (typeof value !== "string" || value.length < MIN_VALUE_LENGTH) return false;
  if (SECRET_NAME.test(name)) return true;
  // Non-credential names in env files (ports, flags, paths) stay readable
  // unless the value itself is token-shaped.
  return (
    value.length >= 16 &&
    !value.startsWith("/") &&
    /^[A-Za-z0-9_\-+=/.]+$/.test(value) &&
    looksLikeToken(value)
  );
}

export function defaultSecretFiles(env = process.env) {
  if (env.SECRET_SCRUB_FILES != null)
    return env.SECRET_SCRUB_FILES.split(":").filter(Boolean);
  const home = homedir();
  const base = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const state = env.PROXY_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "claude-codex-proxy");
  return [
    join(base, "oauth-token"),
    join(state, "accounts/*/oauth-token"),
    join(home, ".config/zsh/secrets.zsh"),
    join(home, ".config/spotlike/env"),
    join(home, ".config/gh/hosts.yml"),
    join(home, ".railway/config.json"),
    join(home, ".codex/auth.json"),
    join(home, ".local/state/today/codex-home/auth.json"),
    join(home, ".claude/.credentials.json"),
    join(home, ".local/state/claude-codex-proxy/accounts/*/.credentials.json"),
    join(home, ".config/.wrangler/config/default.toml"),
    join(home, ".config/agent-gate/client.json"),
    join(home, ".config/envx/keys/*/private.key"),
    // alex-0229: Today's abliteration.ai key (codex-model-router reads it).
    join(home, ".config/today/abliteration.key"),
  ];
}

/**
 * @param {{ files?: string[], refreshMs?: number, load?: (file: string) => Iterable<[string, string]>, now?: () => number }} [options]
 */
export function createScrubber(options = {}) {
  const files = options.files ?? defaultSecretFiles();
  const refreshMs = options.refreshMs ?? 5000;
  const load = options.load ?? loadSecretEntries;
  const now = options.now ?? Date.now;
  // value -> names. Values are kept after rotation for the life of the
  // process, so a replayed transcript that still holds a retired token stays
  // redacted.
  const known = new Map();
  const labels = new Map();
  const stamps = new Map();
  let literal = null;
  let checkedAt = -Infinity;

  function stamp(file) {
    try {
      const stat = statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  function refresh() {
    const at = now();
    if (at - checkedAt < refreshMs) return;
    checkedAt = at;
    let changed = false;
    // Globs are re-expanded each refresh so a new account dir or key is seen.
    for (const file of expandSecretPaths(files)) {
      const current = stamp(file);
      if (stamps.get(file) === current) continue;
      stamps.set(file, current);
      for (const [name, value] of load(file)) {
        if (!isSecretValue(name, value)) continue;
        const names = known.get(value) ?? new Set();
        if (names.has(name)) continue;
        names.add(name);
        known.set(value, names);
        labels.set(value, [...names].sort().join("|"));
        changed = true;
      }
    }
    if (changed) {
      // Longest first so a value containing another is replaced whole.
      const values = [...known.keys()].sort((a, b) => b.length - a.length);
      literal = new RegExp(values.map(escapeRegExp).join("|"), "g");
    }
  }

  function scrub(text) {
    if (typeof text !== "string" || text.length < MIN_VALUE_LENGTH) return text;
    refresh();
    let out = scrubOAuthAssignments(text);
    if (literal) out = out.replace(literal, (value) => `[REDACTED:${labels.get(value)}]`);
    out = redactTruncatedArmor(redactArmoredKeys(out));
    for (const [pattern, label] of PATTERNS)
      out = out.replace(pattern, `[REDACTED:${label}]`);
    out = out.replace(ASSIGNMENT, (whole, name, separator, value) =>
      name !== OAUTH_NAME && looksLikeToken(value) ? `${name}${separator}[REDACTED:${name}]` : whole,
    );
    return out;
  }

  /** Copy-on-write walk: returns the same object when nothing changed. */
  function scrubValue(value, key) {
    if (typeof value === "string") {
      if (key === OAUTH_NAME && isOAuthToken(value)) return OAUTH_MARKER;
      if (key === "encrypted_content" || value.startsWith("data:")) return value;
      return scrub(value);
    }
    if (Array.isArray(value)) {
      let copy = null;
      for (let index = 0; index < value.length; index++) {
        const next = scrubValue(value[index], key);
        if (next !== value[index]) {
          copy ??= value.slice();
          copy[index] = next;
        }
      }
      return copy ?? value;
    }
    if (value && typeof value === "object") {
      let copy = null;
      for (const name of Object.keys(value)) {
        // Tool schemas are static and large; credentials do not live there.
        if (name === "tools") continue;
        const next = scrubValue(value[name], name);
        if (next !== value[name]) {
          copy ??= { ...value };
          copy[name] = next;
        }
      }
      return copy ?? value;
    }
    return value;
  }

  return {
    scrub,
    scrubRequest: (request) => scrubValue(request, ""),
    /** Names only, for diagnostics. Never expose values. */
    names: () => {
      refresh();
      return [...new Set([...known.values()].flatMap((names) => [...names]))].sort();
    },
  };
}

let shared = null;

/** Scrub a Responses request with the process-wide scrubber. */
export function scrubRequest(request) {
  if (process.env.SECRET_SCRUB_DISABLE === "1") return request;
  shared ??= createScrubber();
  return shared.scrubRequest(request);
}

export function scrubText(text) {
  if (process.env.SECRET_SCRUB_DISABLE === "1") return text;
  shared ??= createScrubber();
  return shared.scrub(text);
}
