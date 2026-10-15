import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { turnMetadata } from "./hygiene";
import { isCompactionRequest } from "./request";
import { scrubText } from "./scrub.mjs";
import type { ResponsesRequest } from "./types";

const configPath = () =>
  process.env.SKILL_PRELOAD_CONFIG ??
  join(homedir(), ".config", "claude-codex-proxy", "skill-preloads.json");

/** Local configuration only: request text cannot choose files to load. */
export function preloadSkills(request: ResponsesRequest): ResponsesRequest {
  const threadId = request.prompt_cache_key;
  if (typeof threadId !== "string" || !threadId) return request;
  const meta = turnMetadata(request);
  if (
    meta.threadSource === "subagent" ||
    meta.threadSource === "memory_consolidation" ||
    (meta.requestKind && meta.requestKind !== "turn") ||
    isCompactionRequest(request)
  )
    return request;

  try {
    let source: string;
    try {
      source = readFileSync(configPath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return request;
      throw error;
    }
    const config = JSON.parse(source);
    const threads = config?.threads;
    if (!threads || typeof threads !== "object" || Array.isArray(threads))
      throw new Error("Invalid thread map");
    if (!Object.hasOwn(threads, threadId)) return request;
    const paths: unknown = threads[threadId];
    if (
      !Array.isArray(paths) ||
      paths.some((path) => typeof path !== "string" || !isAbsolute(path))
    )
      throw new Error("Invalid skill paths");
    if (paths.length === 0) return request;

    // Read on every request so edits and removals take effect on the next turn.
    const skills = [...new Set(paths as string[])].map((path) => {
      const file = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
      const body = file
        .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
        .trim();
      if (!body) throw new Error("Empty skill");
      const text = scrubText(body);
      return {
        path,
        text,
        sha256: createHash("sha256").update(text).digest("hex"),
      };
    });
    const content =
      "<preloaded_skills>\nThese local skills are preloaded for this chat. Apply each when its task is relevant.\n\n" +
      skills
        .map(
          ({ path, text }) => `Skill source: ${JSON.stringify(path)}\n${text}`,
        )
        .join("\n\n") +
      "\n</preloaded_skills>";
    const input =
      typeof request.input === "string"
        ? [{ role: "user", content: request.input }]
        : request.input;
    if (input[0]?.role === "developer" && input[0].content === content)
      return request;
    // Record receipt metadata, never the prompt or skill contents.
    console.info(
      "skill-preload:",
      JSON.stringify({
        threadId,
        skills: skills.map(({ path, sha256 }) => ({ path, sha256 })),
      }),
    );
    return { ...request, input: [{ role: "developer", content }, ...input] };
  } catch {
    // Files and JSON errors can contain private source text; return a fixed diagnostic.
    throw new Error(
      "Skill preload failed; check the local skill-preloads.json configuration and skill files.",
    );
  }
}
