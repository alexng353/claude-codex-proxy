import { runClaude } from "./claude";
import { validateRequest } from "./request";
import { responseObject, streamResponse } from "./responses";

const json = (value: unknown, status = 200) => Response.json(value, { status });
const error = (message: string, status = 400) => json({ error: { message, type: "invalid_request_error" } }, status);

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
  apply_patch_tool_type: "freeform",
  truncation_policy: { mode: "bytes", limit: 100_000 },
  supports_image_detail_original: false,
  context_window: 200_000,
  experimental_supported_tools: [],
  input_modalities: ["text"],
  base_instructions: "You are a coding agent. Follow the instructions and use the supplied tools when needed.",
}));

function authorized(request: Request): boolean {
  const apiKey = process.env.PROXY_API_KEY;
  if (!apiKey) return true;
  return request.headers.get("authorization") === `Bearer ${apiKey}`;
}

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return json({ status: "ok" });
  if (!authorized(request)) return error("Invalid API key", 401);
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return json({
      models: modelCatalog,
      object: "list",
      data: modelCatalog.map((model) => ({ id: model.slug, object: "model", created: 0, owned_by: "anthropic-subscription" })),
    });
  }
  if (url.pathname !== "/v1/responses" || request.method !== "POST") return error("Not found", 404);

  try {
    const body = validateRequest(await request.json());
    const output = await runClaude(body);
    const response = responseObject(body, output);
    return body.stream ? streamResponse(response) : json(response);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const status = message.startsWith("Unsupported Claude model") ? 400 : 502;
    return error(message, status);
  }
}
