import type { ResponseInputItem, ResponsesRequest, ResponseTool } from "./types";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const COMPUTER_TOOL_NAME = "__codex_computer_use";
export const TOOL_SEARCH_NAME = "__codex_tool_search";

export type ToolDescriptor = {
  proxyName: string;
  name: string;
  namespace?: string;
  type: "function" | "custom" | "computer" | "tool_search";
  description?: string;
  contract?: unknown;
};

export function toolDescriptors(tools: ResponseTool[]): ToolDescriptor[] {
  const descriptors: ToolDescriptor[] = [];
  for (const tool of tools) {
    if (tool.type === "tool_search") {
      descriptors.push({
        proxyName: TOOL_SEARCH_NAME,
        name: "tool_search",
        type: "tool_search",
        description: tool.description ?? "Search deferred Codex tools and load matching tools for the next model call.",
        contract: {
          type: "object",
          properties: {
            query: { type: "string", description: "Specific names and capabilities of the deferred tools to load." },
            limit: { type: "number", description: "Maximum tools to load. Defaults to 8." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      });
      continue;
    }
    if (tool.type === "namespace") {
      descriptors.push(...toolDescriptors(tool.tools ?? []).map((nested) => ({
        ...nested,
        namespace: tool.name,
        proxyName: `${tool.name}.${nested.proxyName}`,
      })));
      continue;
    }
    if (tool.type === "computer" || tool.type === "computer_use_preview") {
      descriptors.push({ proxyName: COMPUTER_TOOL_NAME, name: "computer", type: "computer", description: "Control the Codex Desktop browser using visual computer actions." });
      continue;
    }
    if (!tool.name) continue;
    descriptors.push({
      proxyName: tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name,
      name: tool.name,
      namespace: tool.namespace,
      type: tool.type === "custom" ? "custom" : "function",
      description: tool.description,
      contract: tool.type === "custom" ? tool.format : tool.parameters,
    });
  }
  return descriptors;
}

const textFromContent = (content: ResponseInputItem["content"]): string => {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => ["input_text", "output_text", "text"].includes(part.type ?? ""))
    .map((part) => part.text ?? "")
    .join("\n");
};

const serializeItem = (item: ResponseInputItem): string => {
  if (item.type === "tool_search_call") {
    return `<assistant_tool_call name=${JSON.stringify(TOOL_SEARCH_NAME)} call_id=${JSON.stringify(item.call_id)}>\n${JSON.stringify(item.arguments ?? {})}\n</assistant_tool_call>`;
  }
  if (item.type === "tool_search_output") {
    return `<tool_result call_id=${JSON.stringify(item.call_id)}>\n${JSON.stringify(item.tools ?? [])}\n</tool_result>`;
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    return `<assistant_tool_call name=${JSON.stringify(item.name)} call_id=${JSON.stringify(item.call_id)}>\n${item.arguments ?? item.input ?? "{}"}\n</assistant_tool_call>`;
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
    return `<tool_result call_id=${JSON.stringify(item.call_id)}>\n${output ?? ""}\n</tool_result>`;
  }
  if (item.type === "computer_call") {
    return `<assistant_computer_call call_id=${JSON.stringify(item.call_id)}>\n${JSON.stringify(item.actions ?? item.action ?? {})}\n</assistant_computer_call>`;
  }
  if (item.type === "computer_call_output") {
    const paths = item.proxy_image_paths ?? [];
    const images = paths.map((path) => `<computer_screenshot path=${JSON.stringify(path)}>Use Claude's Read tool to inspect this screenshot.</computer_screenshot>`).join("\n");
    return `<computer_result call_id=${JSON.stringify(item.call_id)}>\n${images || JSON.stringify(item.output ?? "")}\n</computer_result>`;
  }
  const role = item.role ?? (item.type === "message" ? "user" : item.type ?? "input");
  return `<${role}>\n${textFromContent(item.content)}\n</${role}>`;
};

const COMPUTER_ACTIONS = {
  actions: [
    { type: "click", x: 100, y: 200, button: "left", keys: [] },
    { type: "double_click", x: 100, y: 200, keys: [] },
    { type: "move", x: 100, y: 200, keys: [] },
    { type: "scroll", x: 100, y: 200, scroll_x: 0, scroll_y: 500, keys: [] },
    { type: "keypress", keys: ["ENTER"] },
    { type: "type", text: "text to enter" },
    { type: "drag", path: [{ x: 100, y: 200 }, { x: 200, y: 300 }], keys: [] },
    { type: "screenshot" },
    { type: "wait" },
  ],
};

const describeTool = (tool: ToolDescriptor): string => {
  const contract = tool.type === "computer" ? COMPUTER_ACTIONS : tool.contract;
  return [
    `- name: ${tool.proxyName}`,
    `  type: ${tool.type}`,
    tool.description ? `  description: ${tool.description}` : "",
    contract ? `  argument_contract: ${JSON.stringify(contract)}` : "",
  ].filter(Boolean).join("\n");
};

export function requestToPrompt(request: ResponsesRequest): string {
  const input = typeof request.input === "string"
    ? `<user>\n${request.input}\n</user>`
    : request.input.map(serializeItem).join("\n\n");
  const tools = toolDescriptors(request.tools ?? []);
  const toolInstructions = tools.length === 0 ? "" : `

<available_tools>
${tools.map(describeTool).join("\n")}
</available_tools>

You are the model inside the Codex agent loop. Return Codex-provided tool requests in tool_calls even when Claude has an equivalent built-in tool. For a function tool, arguments must be a JSON object encoded as a string. For a custom tool, arguments must be the exact raw input string. For ${TOOL_SEARCH_NAME}, arguments must be {"query":"specific tool names and capabilities","limit":8} encoded as JSON; use it before concluding that an instructed MCP, plugin, app, browser, node_repl, or cua_repl tool is unavailable. For ${COMPUTER_TOOL_NAME}, arguments must be one computer action object or {"actions":[...]} encoded as JSON. Use only listed tool names. You may return multiple independent tool calls. Do not claim a Codex tool succeeded until its tool result appears in the conversation. You may use Claude's Read tool to inspect screenshot paths included in computer results.`;

  return [
    request.instructions ? `<instructions>\n${request.instructions}\n</instructions>` : "",
    input,
    toolInstructions,
  ].filter(Boolean).join("\n\n");
}

export function outputSchema(tools: ResponseTool[]): Record<string, unknown> {
  const descriptors = toolDescriptors(tools);
  const properties: Record<string, unknown> = {
    text: { type: "string", description: "Assistant text to show before or instead of tool calls." },
    tool_calls: { type: "array", maxItems: 0 },
  };

  if (descriptors.length > 0) {
    properties.tool_calls = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", enum: descriptors.map((tool) => tool.proxyName) },
          arguments: { type: "string" },
        },
        required: ["name", "arguments"],
        additionalProperties: false,
      },
    };
  }

  return {
    type: "object",
    properties,
    required: ["text", "tool_calls"],
    additionalProperties: false,
  };
}

function screenshotUrls(item: ResponseInputItem): string[] {
  if (item.type !== "computer_call_output") return [];
  const values = Array.isArray(item.output) ? item.output : [item.output];
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const imageUrl = (value as { image_url?: unknown }).image_url;
    return typeof imageUrl === "string" ? [imageUrl] : [];
  });
}

async function imageBytes(url: string): Promise<{ bytes: Uint8Array; extension: string }> {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url);
  if (match) {
    const extension = match[1].split("/")[1].replace("jpeg", "jpg");
    return { bytes: Uint8Array.from(Buffer.from(match[2], "base64")), extension };
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to fetch browser screenshot: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "image/png";
  return { bytes: new Uint8Array(await response.arrayBuffer()), extension: contentType.split("/")[1]?.split(";")[0].replace("jpeg", "jpg") || "png" };
}

export async function prepareClaudePrompt(request: ResponsesRequest): Promise<{ prompt: string; cleanup: () => Promise<void> }> {
  if (typeof request.input === "string") return { prompt: requestToPrompt(request), cleanup: async () => {} };
  const urls = request.input.flatMap(screenshotUrls);
  if (urls.length === 0) return { prompt: requestToPrompt(request), cleanup: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), "claude-codex-browser-"));
  const paths: string[] = [];
  try {
    for (const [index, url] of urls.entries()) {
      const image = await imageBytes(url);
      const path = join(directory, `screenshot-${index}.${image.extension}`);
      await Bun.write(path, image.bytes);
      paths.push(path);
    }
    let cursor = 0;
    const input = request.input.map((item) => {
      const count = screenshotUrls(item).length;
      if (count === 0) return item;
      const next = { ...item, proxy_image_paths: paths.slice(cursor, cursor + count) };
      cursor += count;
      return next;
    });
    return { prompt: requestToPrompt({ ...request, input }), cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function validateRequest(value: unknown): ResponsesRequest {
  if (!value || typeof value !== "object") throw new Error("Request body must be a JSON object");
  const request = value as Partial<ResponsesRequest>;
  if (typeof request.model !== "string" || request.model.length === 0) throw new Error("model is required");
  if (typeof request.input !== "string" && !Array.isArray(request.input)) throw new Error("input must be a string or array");
  if (request.tools && !Array.isArray(request.tools)) throw new Error("tools must be an array");
  return request as ResponsesRequest;
}
