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
  [
    /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END \1PRIVATE KEY\2-----/g,
    "private-key",
  ],
  // A truncated PEM or PGP armor block still leaks its body. PGP armor may
  // open with `Comment: ...` style header lines.
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:\s*[A-Za-z][A-Za-z-]*: [^\n]*)*(?:\s*[A-Za-z0-9+/=]{16,})+/g,
    "private-key",
  ],
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
 */
const ASSIGNMENT =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|_PAT|AUTH_KEY)[A-Za-z0-9_]*)(["']?\s*[=:]\s*["']?)([^\s"'`$\\,;)}\]]{12,})/gi;

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
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(text)) return [];
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
  return [
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
    let out = text;
    if (literal) out = out.replace(literal, (value) => `[REDACTED:${labels.get(value)}]`);
    for (const [pattern, label] of PATTERNS)
      out = out.replace(pattern, `[REDACTED:${label}]`);
    out = out.replace(ASSIGNMENT, (whole, name, separator, value) =>
      looksLikeToken(value) ? `${name}${separator}[REDACTED:${name}]` : whole,
    );
    return out;
  }

  /** Copy-on-write walk: returns the same object when nothing changed. */
  function scrubValue(value, key) {
    if (typeof value === "string") {
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
