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
import { isUnavailable, listAccounts, accountEnv } from "./accounts";
import type { ClassifiedKind, ProofKind } from "./hygiene";

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

export function parseCaptureTime(raw: string): number | null {
  const [stamp, offset] = raw.trim().split("|");
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(stamp ?? "");
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (offset && /^[+-]\d{2}:\d{2}$/.test(offset)) return Date.parse(`${iso}${offset}`);
  // No offset: interpret as Vancouver wall time.
  const utcGuess = Date.parse(`${iso}Z`);
  const local = new Date(utcGuess).toLocaleString("sv-SE", { timeZone: "America/Vancouver" }).replace(" ", "T");
  return utcGuess + (utcGuess - Date.parse(`${local}Z`));
}

// ---- Vision verdict ----

export type Verdict = { kind: ClassifiedKind; confidence: number; reason: string };
export type Classifier = (
  image: DecodedImage,
  wanted: { kinds: ProofKind[]; penance?: string },
) => Promise<Verdict>;

export const CLASSIFIER_SYSTEM =
  "You verify hygiene proof photos for a habit tracker the photographed person set up for himself. Judge only what is visible. Answer through the JSON schema.";

export function classifierPrompt(wanted: { kinds: ProofKind[]; penance?: string }): string {
  const lines = [
    "Classify the photo above as exactly one kind:",
    '- "teeth": a person brushing their teeth, with a toothbrush in or near their mouth.',
    '- "shower": a person who has just showered: visibly wet hair, or wet skin with a shower or bathroom background. A shoulders-up selfie is enough.',
  ];
  if (wanted.penance)
    lines.push(`- "penance": the photo shows this: ${JSON.stringify(wanted.penance)}`);
  lines.push(
    '- "none": anything else, including screenshots, photos of a screen, photos of printed photos, or images with no person.',
    "confidence is your probability (0 to 1) that the chosen kind is right. reason is one short sentence.",
  );
  return lines.join("\n");
}

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["teeth", "shower", "penance", "none"] },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["kind", "confidence", "reason"],
  additionalProperties: false,
};

export function parseVerdict(value: unknown): Verdict {
  const v = value as Partial<Verdict> | null;
  if (!v || !["teeth", "shower", "penance", "none"].includes(v.kind as string))
    throw new Error("classifier returned no usable verdict");
  const confidence = typeof v.confidence === "number" && Number.isFinite(v.confidence) ? v.confidence : 0;
  return {
    kind: v.kind as ClassifiedKind,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: typeof v.reason === "string" ? v.reason.slice(0, 200) : "",
  };
}

const CLASSIFIER_MODEL = process.env.HYGIENE_CLASSIFIER_MODEL ?? "haiku";
const CLASSIFIER_TIMEOUT_MS = 60_000;

/** One-shot Claude Code call on the cheapest model; no session, tools or customizations. */
export const claudeClassifier: Classifier = async (image, wanted) => {
  const account = listAccounts().find((a) => !isUnavailable(a)) ?? listAccounts()[0];
  const { CLAUDECODE: _nested, CLAUDE_CODE_EFFORT_LEVEL: _effort, ...env } = process.env;
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
    for (const line of output.split("\n").reverse()) {
      if (!line.startsWith("{")) continue;
      let event: { type?: string; is_error?: boolean; structured_output?: unknown; result?: string };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "result") continue;
      if (event.is_error) throw new Error("classifier call failed");
      return parseVerdict(event.structured_output ?? JSON.parse(event.result ?? "null"));
    }
    throw new Error("classifier produced no result");
  } finally {
    clearTimeout(timer);
  }
};

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
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Vancouver",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
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
