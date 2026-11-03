import { STRIPPED_ENV } from "./claude-env";
/**
 * Hygiene gate proof checks: hashes, capture time, the vision verdict, and
 * the private archive of accepted photos. Checks hold images in memory and
 * pipe them to ImageMagick or the classifier's stdin; only an accepted photo
 * is written, to the archive.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as accounts from "./accounts";
import {
  accountEnv,
  isLimited,
  isLimitError,
  listAccounts,
  markLimited,
  observeRateLimit,
  type Account,
  type RateLimitInfo,
} from "./accounts";

/** Prefer the newer check that also skips accounts whose login failed. */
const unavailable =
  ((accounts as Record<string, unknown>).isUnavailable as ((account: Account) => boolean) | undefined) ??
  ((account: Account) => isLimited(account));
import type { ClassifiedKind, ProofKind } from "./hygiene";
import { offsetAt, wallTime } from "./zone";

const PHONE_ZONE = "America/Vancouver";

export type DecodedImage = { mediaType: string; bytes: Buffer };

export function decodeDataUrl(url: string): DecodedImage | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  return { mediaType: match[1], bytes: Buffer.from(match[2], "base64") };
}

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const MAGICK = process.env.HYGIENE_MAGICK_BIN ?? "magick";

async function magick(args: string[], input: Buffer): Promise<Buffer | null> {
  try {
    const child = Bun.spawn([MAGICK, ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    child.stdin.write(input);
    await child.stdin.end();
    const timer = setTimeout(() => child.kill(), 15_000);
    const [output, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
    clearTimeout(timer);
    return code === 0 ? Buffer.from(output) : null;
  } catch {
    return null;
  }
}

/**
 * 256-bit difference hash: grayscale 17x16, one bit per horizontal
 * neighbour comparison. Survives re-encoding, resizing and mild edits; a
 * new handheld photo lands far away. Null if ImageMagick cannot decode it.
 */
export async function dhash(bytes: Buffer): Promise<string | null> {
  const pixels = await magick(["-", "-auto-orient", "-colorspace", "Gray", "-resize", "17x16!", "-depth", "8", "gray:-"], bytes);
  if (!pixels || pixels.length !== 17 * 16) return null;
  return dhashFromGray(pixels);
}

export function dhashFromGray(pixels: Uint8Array): string {
  let bits = "";
  for (let row = 0; row < 16; row++)
    for (let col = 0; col < 16; col++)
      bits += pixels[row * 17 + col] < pixels[row * 17 + col + 1] ? "1" : "0";
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance + Math.abs(a.length - b.length) * 4;
}

/**
 * EXIF capture time as epoch ms, or null when absent. EXIF stores local wall
 * time; OffsetTimeOriginal is used when present, otherwise the phone is
 * assumed to be on Vancouver time.
 */
export async function captureTime(bytes: Buffer): Promise<number | null> {
  const out = await magick(["identify", "-format", "%[EXIF:DateTimeOriginal]|%[EXIF:OffsetTimeOriginal]", "-"], bytes)
    .catch(() => null);
  return parseCaptureTime(out?.toString("utf8") ?? "");
}

/** EXIF GPS position, or null when the photo has none (sharing often strips it). Never stored: only its distance to the gym is. */
export async function gpsFix(bytes: Buffer): Promise<{ lat: number; lon: number } | null> {
  const out = await magick(
    ["identify", "-format", "%[EXIF:GPSLatitude]|%[EXIF:GPSLatitudeRef]|%[EXIF:GPSLongitude]|%[EXIF:GPSLongitudeRef]", "-"],
    bytes,
  ).catch(() => null);
  return parseGpsFix(out?.toString("utf8") ?? "");
}

/**
 * exiftool's path. Arch installs it in /usr/bin/vendor_perl, which a systemd
 * unit's PATH usually lacks (found live 2026-11-02: every keepsake would have
 * been dropped). Root-owned system directories are searched before PATH, and
 * it runs with its own small environment (EXIFTOOL_ENV), so a user-writable
 * PATH entry or PERL5* variable isn't picked up. This is hardening, not a
 * boundary: whoever can set HYGIENE_EXIFTOOL_BIN can also edit the proxy.
 */
export function exiftoolBin(env: Record<string, string | undefined> = process.env): string | null {
  if (env.HYGIENE_EXIFTOOL_BIN) return env.HYGIENE_EXIFTOOL_BIN;
  const system = ["/usr/bin/vendor_perl", "/usr/bin/site_perl", "/usr/bin/core_perl", "/usr/bin", "/usr/local/bin"];
  const path = [...system, env.PATH ?? ""].filter(Boolean).join(":");
  return Bun.which("exiftool", { PATH: path });
}
const EXIFTOOL = exiftoolBin();
if (!EXIFTOOL) console.error("hygiene-proof: exiftool not found; photo keepsakes will not be saved");
/** exiftool's shebang is `#!/usr/bin/env perl`: only root-owned directories, and no inherited PERL5* settings. */
const EXIFTOOL_ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
/** The last exiftool error logged: each new error is logged once, and a success clears it. */
let lastExiftoolError: string | null = null;
function noteExiftoolError(error: string | null): void {
  if (error !== null && error !== lastExiftoolError)
    console.error(`hygiene-proof: ${EXIFTOOL} failed (${error.slice(0, 160)}); that photo's keepsake is skipped`);
  lastExiftoolError = error;
}

/**
 * The same image with its location removed: every EXIF GPS tag and all XMP
 * (where apps also write GPS), other EXIF such as the capture time kept.
 * Null unless exiftool succeeded and finds no GPS tag left in any group.
 */
export async function stripGps(image: DecodedImage): Promise<DecodedImage | null> {
  const strip = await exiftool(["-q", "-q", "-gps:all=", "-xmp:all=", "-o", "-", "-"], image.bytes);
  if (!strip?.length) return null;
  // Any tag with GPS in its name, in any group, means something was missed.
  const left = await exiftool(["-q", "-q", "-a", "-s", "-G1", "-*GPS*", "-"], strip);
  if (left === null || left.toString("utf8").trim()) return null;
  return { ...image, bytes: strip };
}

async function exiftool(args: string[], input: Buffer): Promise<Buffer | null> {
  if (!EXIFTOOL) return null;
  try {
    const child = Bun.spawn([EXIFTOOL, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: EXIFTOOL_ENV });
    child.stdin.write(input);
    await child.stdin.end();
    const timer = setTimeout(() => child.kill(), 15_000);
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    noteExiftoolError(code === 0 ? null : `exit ${code}: ${errors.split("\n")[0]}`);
    return code === 0 ? Buffer.from(output) : null;
  } catch (error) {
    // E.g. the binary was removed after startup (ENOENT).
    noteExiftoolError((error as NodeJS.ErrnoException).code ?? (error as Error).message);
    return null;
  }
}

/** "49/1,15/1,6057/125|N|123/1,7/1,1743/125|W" (degrees, minutes, seconds as rationals) to signed decimal degrees. */
export function parseGpsFix(raw: string): { lat: number; lon: number } | null {
  const [lat, latRef, lon, lonRef] = raw.trim().split("|");
  const degrees = (text: string | undefined) => {
    const parts = (text ?? "").split(",").map((p) => {
      const [n, d = "1"] = p.trim().split("/");
      return Number(n) / Number(d);
    });
    if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x) || x < 0)) return null;
    return parts[0] + parts[1] / 60 + parts[2] / 3600;
  };
  const a = degrees(lat);
  const o = degrees(lon);
  if (a === null || o === null || !/^[NS]$/.test(latRef ?? "") || !/^[EW]$/.test(lonRef ?? "")) return null;
  if (a > 90 || o > 180) return null;
  return { lat: latRef === "S" ? -a : a, lon: lonRef === "W" ? -o : o };
}

export function parseCaptureTime(raw: string): number | null {
  const [stamp, offset] = raw.trim().split("|");
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(stamp ?? "");
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (offset && /^[+-]\d{2}:\d{2}$/.test(offset)) return Date.parse(`${iso}${offset}`);
  // No offset: interpret as Vancouver wall time (system zone database, see zone.ts).
  const wall = Date.parse(`${iso}Z`);
  if (Number.isNaN(wall)) return null;
  let guess = wall;
  for (let k = 0; k < 3; k++) guess = wall - offsetAt(guess, PHONE_ZONE).offsetMs;
  return guess;
}

// ---- Vision verdict ----

export type Verdict = {
  kind: ClassifiedKind;
  confidence: number;
  reason: string;
  /** Weigh-ins: the scale's displayed reading with its unit. */
  reading?: string;
};
export type Classifier = (
  image: DecodedImage,
  wanted: { kinds: ProofKind[]; penance?: string },
) => Promise<Verdict>;

export const CLASSIFIER_SYSTEM =
  "You verify hygiene, weigh-in, supplement and walk proof photos for a habit tracker the photographed person set up for himself. Judge only what is visible. Answer through the JSON schema.";

export function classifierPrompt(wanted: { kinds: ProofKind[]; penance?: string }): string {
  const lines = [
    "Classify the photo above as exactly one kind:",
    '- "teeth": a person brushing their teeth, with a toothbrush in or near their mouth.',
    '- "shower": a person who has just showered: visibly wet hair, or wet skin with a shower or bathroom background. A shoulders-up selfie is enough.',
  ];
  if (wanted.kinds.includes("weight"))
    lines.push(
      '- "weight": a real bathroom scale photographed directly, with a weight reading legible on its display. Bare feet on the scale are fine.',
    );
  if (wanted.kinds.includes("creatine"))
    lines.push(
      '- "creatine": creatine being taken, photographed directly: a scoop of white powder, a scoop over or in a glass or shaker, or a glass of water with powder stirred in. A creatine tub in view helps but is not required.',
    );
  if (wanted.kinds.includes("walk"))
    lines.push(
      '- "walk": a photo taken outdoors by someone on foot: a street, sidewalk, path, park, trees or open sky around the camera. Not a view through a window and not from inside a vehicle.',
    );
  if (wanted.penance)
    lines.push(
      `- "penance": the photo shows this: ${JSON.stringify(wanted.penance)}`,
      'If the photo matches the penance, answer "penance" even when it also matches another kind.',
    );
  // Creatine and walk photos have no person in them; only the other kinds need one. A penance
  // says what its photo shows, which may have nobody in it (comb, Nov 3).
  const personless =
    wanted.kinds.includes("creatine") || wanted.kinds.includes("walk") || !!wanted.penance;
  lines.push(
    personless
      ? '- "none": anything else, including screenshots, photos of a screen, photos of printed photos, or images with no person that match none of the kinds above.'
      : '- "none": anything else, including screenshots, photos of a screen, photos of printed photos, or images with no person.',
    "confidence is your probability (0 to 1) that the chosen kind is right. reason is one short sentence.",
    'reading is the displayed weight with its unit (e.g. "72.4 kg" or "231.4 lb") for "weight", otherwise an empty string. Scales often use 7-segment LCD digits: read every digit and the decimal point exactly as shown, and take the unit from the display or the scale\'s unit label. Leave the unit out only if none is visible.',
  );
  return lines.join("\n");
}

const KG_TO_LB = 2.20462;
export const WEIGHT_LB_RANGE = { min: 60, max: 600 } as const;

/**
 * The classifier's scale reading in pounds, rounded to 0.1, or null when it
 * cannot be trusted: no number, no unit (kg and lb ranges overlap), stones,
 * extra numbers, or a value outside 60-600 lb.
 */
export function parseWeightReading(reading: string | null | undefined): number | null {
  if (!reading) return null;
  const match = /^\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(kgs?|kilograms?|lbs?|pounds?)\.?\s*$/i.exec(reading);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  const lb = /^k/i.test(match[2]) ? value * KG_TO_LB : value;
  const rounded = Math.round(lb * 10) / 10;
  if (!Number.isFinite(rounded) || rounded < WEIGHT_LB_RANGE.min || rounded > WEIGHT_LB_RANGE.max) return null;
  return rounded;
}

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["teeth", "shower", "weight", "creatine", "walk", "penance", "none"] },
    confidence: { type: "number" },
    reason: { type: "string" },
    reading: { type: "string" },
  },
  required: ["kind", "confidence", "reason", "reading"],
  additionalProperties: false,
};

export function parseVerdict(value: unknown): Verdict {
  const v = value as Partial<Verdict> | null;
  if (!v || !["teeth", "shower", "weight", "creatine", "walk", "penance", "none"].includes(v.kind as string))
    throw new Error("classifier returned no usable verdict");
  const confidence = typeof v.confidence === "number" && Number.isFinite(v.confidence) ? v.confidence : 0;
  return {
    kind: v.kind as ClassifiedKind,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: typeof v.reason === "string" ? v.reason.slice(0, 200) : "",
    ...(v.kind === "weight" && typeof v.reading === "string" && v.reading.trim()
      ? { reading: v.reading.trim().slice(0, 40) }
      : {}),
  };
}

const CLASSIFIER_MODEL = process.env.HYGIENE_CLASSIFIER_MODEL ?? "haiku";
const CLASSIFIER_TIMEOUT_MS = 60_000;
/** Accounts tried for one photo, and the time after which no further one is started. */
const CLASSIFIER_ACCOUNT_TRIES = 3;
const CLASSIFIER_RETRY_BUDGET_MS = 90_000;

/** The call ran but gave no verdict (an error result, no result, a timeout): another account may. */
class ClassifierCallError extends Error {}

/**
 * One-shot Claude Code call on the cheapest model; no session, tools or customizations. Nov 3:
 * the first account in order had hit its weekly limit but wasn't marked limited, so every
 * photo got "classifier error". A failed call now marks a limited account and moves to the
 * next one, available accounts first.
 */
export const claudeClassifier: Classifier = async (image, wanted) => {
  const all = listAccounts();
  const order = [...all.filter((a) => !unavailable(a)), ...all.filter((a) => unavailable(a))];
  const started = Date.now();
  let last: Error | undefined;
  for (const account of order.slice(0, CLASSIFIER_ACCOUNT_TRIES)) {
    if (last && Date.now() - started > CLASSIFIER_RETRY_BUDGET_MS) break;
    try {
      return await classifyOn(account, image, wanted);
    } catch (error) {
      if (!(error instanceof ClassifierCallError)) throw error;
      last = error;
      console.error(`hygiene-gate: classifier on ${account.name}: ${error.message}`);
    }
  }
  throw last ?? new Error("no Claude account for the classifier");
};

async function classifyOn(
  account: Account,
  image: Parameters<Classifier>[0],
  wanted: Parameters<Classifier>[1],
): Promise<Verdict> {
  const { CLAUDE_CODE_EFFORT_LEVEL: _effort, ...env } = process.env;
  for (const key of STRIPPED_ENV) delete env[key];
  const child = Bun.spawn(
    [
      process.env.CLAUDE_BIN ?? "claude",
      "-p",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      CLASSIFIER_MODEL,
      "--safe-mode",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--tools",
      "",
      "--system-prompt",
      CLASSIFIER_SYSTEM,
      "--json-schema",
      JSON.stringify(VERDICT_SCHEMA),
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.env.CLAUDE_CWD || process.cwd(),
      env: { ...env, ...accountEnv(account) },
    },
  );
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.bytes.toString("base64") } },
        { type: "text", text: classifierPrompt(wanted) },
      ],
    },
  };
  child.stdin.write(`${JSON.stringify(message)}\n`);
  await child.stdin.end();
  const timer = setTimeout(() => child.kill(), CLASSIFIER_TIMEOUT_MS);
  try {
    const output = await new Response(child.stdout).text();
    await child.exited;
    type Event = {
      type?: string;
      is_error?: boolean;
      structured_output?: unknown;
      result?: string;
      rate_limit_info?: RateLimitInfo;
    };
    const events: Event[] = [];
    for (const line of output.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
    // Like a chat turn: what the account reports about its limits counts toward picking it.
    for (const event of events)
      if (event.type === "rate_limit_event") observeRateLimit(account, event.rate_limit_info ?? {});
    const result = [...events].reverse().find((event) => event.type === "result");
    if (!result) throw new ClassifierCallError("classifier produced no result");
    if (result.is_error) {
      const why = (result.result ?? "").slice(0, 200);
      if (isLimitError(undefined, why)) markLimited(account);
      throw new ClassifierCallError(`classifier call failed: ${why || "no reason given"}`);
    }
    return parseVerdict(result.structured_output ?? JSON.parse(result.result ?? "null"));
  } finally {
    clearTimeout(timer);
  }
}

// ---- Archive ----

export function photoDir(): string {
  return process.env.HYGIENE_PHOTO_DIR ?? join(homedir(), "Documents", "private", "hygiene");
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
};

/**
 * Saves an accepted proof as `<root>/YYYY/MM/DD/<kind>-<HHMMSS>-<sha8>.<ext>`
 * (Vancouver time), byte for byte. Directories are 0700 and the file 0600.
 */
export function archivePhoto(image: DecodedImage, kind: string, at: number, hash: string): string {
  const w = wallTime(at, PHONE_ZONE);
  const pad = (n: number) => String(n).padStart(2, "0");
  const parts = { year: String(w.year), month: pad(w.month), day: pad(w.day), hour: pad(w.hour), minute: pad(w.minute), second: pad(w.second) };
  let directory = photoDir();
  for (const segment of ["", parts.year, parts.month, parts.day]) {
    directory = segment ? join(directory, segment) : directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const ext = EXTENSIONS[image.mediaType.toLowerCase()] ?? "img";
  const file = join(directory, `${kind}-${parts.hour}${parts.minute}${parts.second}-${hash.slice(0, 8)}.${ext}`);
  writeFileSync(file, image.bytes, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
