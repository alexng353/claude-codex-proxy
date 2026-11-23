/**
 * Today's no-tools side calls (/summary and automatic catch-up summaries) at the
 * Codex model router (q no-tools-code-mode, Nov 23).
 *
 * Today's daemon opens a side call's developer instructions with
 * SIDE_CALL_MARKER as the whole first line (today-proto `mark_side_call`), and only
 * there. The hygiene gate exempts such a request because it can't act. That holds only
 * while the request carries no tools. Codex takes code mode (`exec`, `wait`) from
 * the model's catalog entry, and no config key turns it off. So the router checks
 * the wire itself: a marked request that carries any tool is logged, or refused once
 * refusing is switched on (refuseEnabled). The check never depends on the gate,
 * which forwards when it is down.
 *
 * A tool-free side call runs on a hidden catalog slug (SIDE_MODEL_ALIASES) that
 * OpenAI doesn't know. The router sends the real model name upstream, in the body
 * and in the turn-metadata header. Exact names only: nothing is matched by prefix.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SIDE_CALL_MARKER = "<today-side-call/>";

/** Hidden side-call catalog slug -> the model OpenAI serves. */
export const SIDE_MODEL_ALIASES = Object.freeze({ "gpt-6.1-sol-side": "gpt-6.1-sol" });

const marked = (text) =>
  typeof text === "string" && (text === SIDE_CALL_MARKER || text.startsWith(`${SIDE_CALL_MARKER}\n`));
const partsOf = (item) =>
  typeof item?.content === "string"
    ? [{ type: "input_text", text: item.content }]
    : Array.isArray(item?.content)
      ? item.content
      : [];
const isContextMessage = (item) =>
  (item?.role === "developer" || item?.role === "system") &&
  (item.type === undefined || item.type === "message");

/**
 * The request is a Today side call: its instructions, or a developer or system
 * message part, open with the marker. Only that position counts. Today escapes `<`
 * in every copy of earlier conversation, so quoted history can't mark a chat.
 */
export function isSideCall(request) {
  if (!request || typeof request !== "object") return false;
  if (marked(request.instructions)) return true;
  if (!Array.isArray(request.input)) return false;
  return request.input.some((item) => isContextMessage(item) && partsOf(item).some((part) => marked(part?.text)));
}

function toolNames(tool, into) {
  if (!tool || typeof tool !== "object") {
    into.push("unnamed");
    return;
  }
  const name = typeof tool.name === "string" ? tool.name : typeof tool.type === "string" ? tool.type : "unnamed";
  if (Array.isArray(tool.tools) && tool.tools.length) {
    for (const child of tool.tools) {
      const inner = [];
      toolNames(child, inner);
      for (const n of inner) into.push(`${name}.${n}`);
    }
  } else into.push(name);
}

/**
 * Every tool the request offers the model: `tools`, and the tools Codex sends as
 * an `additional_tools` input item (code mode's namespaces travel that way). An
 * empty namespace or item counts too: the model is still offered a name.
 */
export function carriedTools(request) {
  const names = [];
  if (Array.isArray(request?.tools)) for (const tool of request.tools) toolNames(tool, names);
  if (Array.isArray(request?.input))
    for (const item of request.input)
      if (item?.type === "additional_tools") {
        if (Array.isArray(item.tools) && item.tools.length) for (const tool of item.tools) toolNames(tool, names);
        else names.push("additional_tools");
      }
  return names;
}

/**
 * Refusing is switched on per machine by a file. It is off by default, so a router
 * update never breaks summaries on a machine whose daemon or catalog has no side slug.
 * The env var points the check at another file, for tests.
 */
export function refuseFlagPath(env = process.env) {
  return env.CODEX_ROUTER_SIDE_CALL_REFUSE_FILE || join(homedir(), ".config/codex-model-router/refuse-side-call-tools");
}
export function refuseEnabled(env = process.env, exists = existsSync) {
  try {
    return exists(refuseFlagPath(env));
  } catch {
    return false;
  }
}

/**
 * null: not a side call, or a side call with no tools (forward it). Otherwise the
 * tools it carries, and whether to refuse it.
 */
export function sideCallCheck(request, { refuse = false } = {}) {
  if (!isSideCall(request)) return null;
  const tools = carriedTools(request);
  return tools.length ? { tools, refuse } : null;
}

export const SIDE_CALL_REFUSED_CODE = "side_call_tools_refused";

export function refusalMessage(model, tools) {
  const shown = tools.slice(0, 8).join(", ") + (tools.length > 8 ? `, and ${tools.length - 8} more` : "");
  return (
    `Today side call refused by the model router: a no-tools side call (/summary) on ${model ?? "an unknown model"} ` +
    `carries tools (${shown}). Its catalog entry gives tools that no config key turns off. ` +
    `No request was sent to the model. Fix: run summaries on the tool-free side slug (q no-tools-code-mode).`
  );
}

/** The body of an HTTP refusal (status 400: Codex fails the turn and shows the message). */
export function refusalBody(model, tools) {
  return {
    error: { type: "invalid_request_error", code: SIDE_CALL_REFUSED_CODE, message: refusalMessage(model, tools) },
  };
}

/** A websocket `error` frame carrying the refusal, the shape the router already uses. */
export function refusalFrame(model, tools) {
  return { type: "error", ...refusalBody(model, tools) };
}

export function wireModel(model) {
  return typeof model === "string" && Object.hasOwn(SIDE_MODEL_ALIASES, model) ? SIDE_MODEL_ALIASES[model] : model;
}

/** The request with an aliased model replaced; the same object when nothing changes. */
export function aliasRequest(request) {
  if (!request || typeof request !== "object") return request;
  const model = wireModel(request.model);
  return model === request.model ? request : { ...request, model };
}

/** The x-codex-turn-metadata header with an aliased model replaced; unchanged otherwise. */
export function aliasMetadataHeader(value) {
  if (typeof value !== "string") return value;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.model !== "string") return value;
  const model = wireModel(parsed.model);
  return model === parsed.model ? value : JSON.stringify({ ...parsed, model });
}

/** Headers with the turn-metadata model aliased; the same object when nothing changes. */
export function aliasHeaders(headers) {
  const key = "x-codex-turn-metadata";
  if (!headers || typeof headers[key] !== "string") return headers;
  const value = aliasMetadataHeader(headers[key]);
  return value === headers[key] ? headers : { ...headers, [key]: value };
}
