import { threadAgentName } from "./sessions";
import type { ResponsesRequest } from "./types";

/**
 * A chat's own agent name (Alex, Oct 31: "bubble powered by <whatever>").
 *
 * A chat with a name set (sessions.sqlite thread_agent_names, keyed by Codex
 * thread id = prompt_cache_key, written through /agent-names) is told
 * "You are NAME, powered by MODEL (VENDOR)." Chats without one are unchanged.
 *
 * The model is always the one serving this request, read from the request
 * itself; a model this file cannot name gets no line rather than a guess.
 *
 * - Claude: the line opens the system prompt file. Claude Code still puts its
 *   own fixed "You are a Claude agent, built on Anthropic's Claude Agent SDK."
 *   before it: that prefix is one of the few the subscription accepts, so it
 *   cannot be swapped out.
 * - GPT (through the model router's /hygiene/gate call): the line replaces the
 *   leading "You are Codex, ..." sentence of Codex's base instructions, or is
 *   put in front when there is none.
 */

export type ModelIdentity = { name: string; vendor: string };

// Letters, digits, spaces and ' , & - only, starting with a letter or digit, at most
// 40 code points. No '.', ':', '(' or ')', so a name can't end the sentence and
// start an instruction. The whole words in MODEL_WORDS are refused too, so a name
// can't say which model or vendor it runs on: only the line itself says that.
// Today's agent_identity.rs uses the same rule and counts the same way.
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ',&-]{0,39}$/u;
const MODEL_WORDS = new Set(["powered", "model", "gpt", "claude", "openai", "anthropic"]);

/** See NAME and MODEL_WORDS (case-insensitive, whole words); no trailing space. */
export function validAgentName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    NAME.test(name) &&
    !name.endsWith(" ") &&
    !name.split(/[^\p{L}\p{N}]+/u).some((word) => MODEL_WORDS.has(word.toLowerCase()))
  );
}

const capital = (word: string) => (word ? word[0].toUpperCase() + word.slice(1) : word);

/**
 * The display name and vendor of an exact model id. Undefined for anything that
 * does not name one model: unknown ids, versionless aliases (opus), dated
 * snapshots (claude-opus-4-20250514) and pointers (gpt-...-latest).
 */
export function modelIdentity(model: string): ModelIdentity | undefined {
  if (!/^[a-z0-9.-]+$/.test(model)) return undefined;
  const claude = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?$/.exec(model);
  if (claude) {
    const version = claude[3] === undefined ? claude[2] : `${claude[2]}.${claude[3]}`;
    return { name: `Claude ${capital(claude[1])} ${version}`, vendor: "Anthropic" };
  }
  // OpenAI's own spelling: gpt-6.1-sol is GPT-6.1-Sol. A version, then words only.
  if (/^gpt-\d{1,2}(?:\.\d{1,2})?(?:-[a-z]+)*$/.test(model) && !model.endsWith("-latest"))
    return { name: `GPT-${model.slice(4).split("-").map(capital).join("-")}`, vendor: "OpenAI" };
  if (/^abliterated-model(?:-[a-z0-9-]+)?$/.test(model))
    return { name: model, vendor: "abliteration.ai" };
  return undefined;
}

export function agentIdentityLine(name: string, model: string): string | undefined {
  const identity = modelIdentity(model);
  if (!identity || !validAgentName(name)) return undefined;
  return `You are ${name}, powered by ${identity.name} (${identity.vendor}).`;
}

function lineFor(request: ResponsesRequest): string | undefined {
  const threadId = request.prompt_cache_key;
  if (typeof threadId !== "string" || !threadId) return undefined;
  let name: string | undefined;
  try {
    name = threadAgentName(threadId);
  } catch (cause) {
    // A broken database costs the name, never the turn.
    console.error("agent-identity: unable to read the agent name:", (cause as Error).message);
    return undefined;
  }
  return name === undefined ? undefined : agentIdentityLine(name, request.model);
}

/** Only this file sets agentIdentity; a client-sent one is dropped. */
function withoutClientIdentity(request: ResponsesRequest): ResponsesRequest {
  if (!("agentIdentity" in request)) return request;
  const { agentIdentity: _ignored, ...rest } = request;
  return rest;
}

/** Claude route: the line rides on the request into the system prompt and the worker key. */
export function withAgentIdentity(request: ResponsesRequest): ResponsesRequest {
  const clean = withoutClientIdentity(request);
  const line = lineFor(clean);
  return line ? { ...clean, agentIdentity: line } : clean;
}

// To the first period that ends the sentence: "based on GPT-6.1. You" keeps "6.1".
const CODEX_SENTENCE = /^You are Codex\b[^\n]*?\.(?=\s|$)/;

/** GPT route: the line goes into the instructions OpenAI receives. */
export function withAgentInstructions(request: ResponsesRequest): ResponsesRequest {
  const clean = withoutClientIdentity(request);
  const line = lineFor(clean);
  if (!line) return clean;
  const instructions = typeof clean.instructions === "string" ? clean.instructions : "";
  // Already applied (a retry of a rewritten request): leave it as is.
  if (instructions === line || instructions.startsWith(`${line} `) || instructions.startsWith(`${line}\n`))
    return clean;
  const codex = CODEX_SENTENCE.exec(instructions);
  const next = codex
    ? line + instructions.slice(codex[0].length)
    : instructions
      ? `${line}\n\n${instructions}`
      : line;
  return { ...clean, instructions: next };
}
