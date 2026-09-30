import { accountStatus, usageHeaders } from "./accounts";
import { runClaude } from "./claude";
import { validateRequest } from "./request";
import { responseObject, streamResponse } from "./responses";

const json = (value: unknown, status = 200) => Response.json(value, { status });
const error = (message: string, status = 400) =>
  json({ error: { message, type: "invalid_request_error" } }, status);

const modelCatalog = ["opus", "sonnet", "haiku"].map((model, index) => ({
  slug: model,
  display_name: `Claude ${model[0].toUpperCase()}${model.slice(1)}`,
  description: `Claude Code ${model} alias through the local subscription proxy`,
  default_reasoning_level: "none",
  supported_reasoning_levels: [],
  shell_type: "unified_exec",
  visibility: "list",
  supported_in_api: true,
  priority: 3 - index,
  availability_nux: null,
  upgrade: null,
  support_verbosity: false,
  default_verbosity: null,
  supports_parallel_tool_calls: true,
  apply_patch_tool_type: "freeform",
  include_skills_usage_instructions: true,
  include_plugin_usage_instructions: true,
  include_apps_usage_instructions: true,
  node_repl_auto_review_required: false,
  node_repl_disabled: false,
  supports_search_tool: true,
  truncation_policy: { mode: "bytes", limit: 100_000 },
  supports_image_detail_original: true,
  context_window: model === "haiku" ? 200_000 : 1_000_000,
  experimental_supported_tools: [],
  input_modalities: ["text", "image"],
  base_instructions:
    "You are a coding agent. Follow the instructions and use every supplied Codex tool when needed. Codex tools are available even when they are not registered as native tools in the underlying model runtime.",
}));

function authorized(request: Request): boolean {
  const apiKey = process.env.PROXY_API_KEY;
  if (!apiKey) return true;
  return request.headers.get("authorization") === `Bearer ${apiKey}`;
}

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET")
    return json({ status: "ok" });
  if (!authorized(request)) return error("Invalid API key", 401);
  if (url.pathname === "/accounts" && request.method === "GET")
    return json({ accounts: accountStatus() });
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return json({
      models: modelCatalog,
      object: "list",
      data: modelCatalog.map((model) => ({
        id: model.slug,
        object: "model",
        created: 0,
        owned_by: "anthropic-subscription",
      })),
    });
  }
  if (url.pathname !== "/v1/responses" || request.method !== "POST")
    return error("Not found", 404);

  try {
    const body = validateRequest(await request.json());
    const output = await runClaude(body);
    const response = responseObject(body, output);
    const reply = body.stream ? streamResponse(response) : json(response);
    for (const [name, value] of Object.entries(usageHeaders(output.account)))
      reply.headers.set(name, value);
    return reply;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const status = message.startsWith("Unsupported Claude") ? 400 : 502;
    return error(message, status);
  }
}
