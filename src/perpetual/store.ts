import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { emptyView, type ViewState } from "./view";

/**
 * One perpetual chat on disk (gist section 1):
 *
 *   main/YYYY-MM-DD.jsonl   messages {i, kind, text, size, date, key, ...}
 *   tree/YYYY-MM-DD.jsonl   tree nodes {l, i, text, size}
 *   view.json               the turn view; never rebuilt from the log
 *   cview.json              the compactions' smaller view
 *   state.json              proxy-answered tool items awaiting Codex's history
 *   images/                 image bytes referenced by messages
 *
 * Logs are append-only: each write is flushed and no line is ever edited. One
 * process owns a chat, enforced by `lock`.
 */

export type MessageKind = "user" | "assistant" | "tool" | "echo" | "work" | "note";

export type LoggedImage = { path: string; caption: string };

export type LogMessage = {
  i: number;
  kind: MessageKind;
  text: string;
  /** UTF-8 bytes of text. */
  size: number;
  date: string;
  /** Identity of the Codex item this came from (see itemKeys). */
  key: string;
  /** Which part of a long item this is, when it was split. */
  part?: number;
  images?: LoggedImage[];
};

export type NewMessage = Omit<LogMessage, "i" | "size" | "date">;

/** A group of proxy-answered items Codex never saw, re-inserted after `anchor`. */
export type Injection = { anchor: string; items: unknown[] };

type ThreadState = { injections: Injection[] };

export class LockedError extends Error {}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const nodeKey = (level: number, index: number) => `${level}:${index}`;

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readJsonl<T>(directory: string): T[] {
  if (!existsSync(directory)) return [];
  const records: T[] = [];
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".jsonl")).sort())
    for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as T);
      } catch {
        // A torn last line from a crash; the record it held was never acknowledged.
      }
    }
  return records;
}

function appendLines(directory: string, lines: string[]): void {
  if (lines.length === 0) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, `${localDate(new Date())}.jsonl`), "a", 0o600);
  try {
    writeSync(fd, lines.map((line) => `${line}\n`).join(""));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const heldLocks = new Set<string>();
process.on("exit", () => {
  for (const path of heldLocks)
    try {
      unlinkSync(path);
    } catch {}
});

/** Takes the chat's lock for this process; a dead owner's lock is reclaimed. */
function acquireLock(path: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      heldLocks.add(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = Number(readFileSync(path, "utf8").trim());
    if (owner === process.pid) {
      heldLocks.add(path);
      return;
    }
    if (owner > 0 && processAlive(owner))
      throw new LockedError(`perpetual chat is owned by process ${owner}`);
    unlinkSync(path);
  }
  throw new LockedError("perpetual chat lock is contended");
}

export class ThreadStore {
  readonly messages: LogMessage[] = [];
  private readonly nodes = new Map<string, string>();
  private readonly keyIds = new Map<string, number[]>();
  view: ViewState;
  cview: ViewState;
  private state: ThreadState;

  constructor(readonly dir: string) {
    mkdirSync(join(dir, "images"), { recursive: true, mode: 0o700 });
    acquireLock(join(dir, "lock"));
    for (const message of readJsonl<LogMessage>(join(dir, "main"))) {
      // Ids are positions; a duplicate or gap means a damaged log, and a
      // message out of place is worse than one missing.
      if (message.i !== this.messages.length) continue;
      this.remember(message);
    }
    for (const node of readJsonl<{ l: number; i: number; text: string }>(join(dir, "tree")))
      if (!this.nodes.has(nodeKey(node.l, node.i))) this.nodes.set(nodeKey(node.l, node.i), node.text);
    this.view = readJson(join(dir, "view.json"), emptyView());
    this.cview = readJson(join(dir, "cview.json"), emptyView());
    this.state = readJson(join(dir, "state.json"), { injections: [] });
  }

  private remember(message: LogMessage): void {
    this.messages.push(message);
    const ids = this.keyIds.get(message.key) ?? [];
    ids.push(message.i);
    this.keyIds.set(message.key, ids);
  }

  get length(): number {
    return this.messages.length;
  }

  idsOf(key: string): number[] | undefined {
    return this.keyIds.get(key);
  }

  append(messages: NewMessage[], now = new Date()): LogMessage[] {
    const records = messages.map((message, offset) => ({
      i: this.messages.length + offset,
      kind: message.kind,
      text: message.text,
      size: bytes(message.text),
      date: now.toISOString(),
      key: message.key,
      ...(message.part !== undefined ? { part: message.part } : {}),
      ...(message.images?.length ? { images: message.images } : {}),
    }));
    appendLines(join(this.dir, "main"), records.map((record) => JSON.stringify(record)));
    for (const record of records) this.remember(record);
    return records;
  }

  node(level: number, index: number): string | undefined {
    return this.nodes.get(nodeKey(level, index));
  }

  built(level: number, index: number): boolean {
    return this.nodes.has(nodeKey(level, index));
  }

  /** Records a node once; a node is never built again. */
  addNode(level: number, index: number, text: string): void {
    if (this.built(level, index)) return;
    appendLines(join(this.dir, "tree"), [JSON.stringify({ l: level, i: index, text, size: bytes(text) })]);
    this.nodes.set(nodeKey(level, index), text);
  }

  /** Built tree nodes, for rebuilding the work queues at load. */
  builtNodes(): Array<[number, number]> {
    return [...this.nodes.keys()].map((key) => key.split(":").map(Number) as [number, number]);
  }

  saveView(): void {
    writeAtomic(join(this.dir, "view.json"), this.view);
  }

  saveCView(): void {
    writeAtomic(join(this.dir, "cview.json"), this.cview);
  }

  get injections(): readonly Injection[] {
    return this.state.injections;
  }

  setInjections(injections: Injection[]): void {
    this.state = { ...this.state, injections };
    writeAtomic(join(this.dir, "state.json"), this.state);
  }

  /** Saves image bytes under images/, named by content hash. */
  saveImage(mediaType: string, data: Buffer): LoggedImage {
    const extension = mediaType.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
    const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    const path = join(this.dir, "images", `${hash}.${extension}`);
    if (!existsSync(path)) writeFileSync(path, data, { mode: 0o600 });
    return { path, caption: `${mediaType}, ${Math.max(1, Math.round(data.length / 1024))} KB` };
  }
}
