import type {
  ResponseContentPart,
  ResponseInputItem,
  ResponsesRequest,
  ResponseTool,
} from "./types";

export const COMPUTER_TOOL_NAME = "__codex_computer_use";
export const TOOL_SEARCH_NAME = "__codex_tool_search";

/**
 * Codex's own compaction prompt and summary prefix (codex-rs
 * prompts/templates/compact, 0.155), so a Claude conversation compacted here
 * reads like one Codex compacted locally.
 */
export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
export const SUMMARY_PREFIX = `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:`;

/**
 * Marks compaction items this proxy wrote. Codex stores `encrypted_content`
 * opaquely and returns it unchanged in later requests; an item OpenAI wrote is
 * encrypted for OpenAI and cannot be read here.
 */
const COMPACTION_PREFIX = "claude-codex-proxy.compaction.v1:";
const COMPACTION_ITEM_TYPES = new Set([
  "compaction",
  "compaction_summary",
  "context_compaction",
]);

/** Codex remote compaction (v2) appends this item to the history it wants summarized. */
export const isCompactionRequest = (request: ResponsesRequest): boolean =>
  Array.isArray(request.input) &&
  request.input.at(-1)?.type === "compaction_trigger";

export const encodeCompaction = (summary: string): string =>
  COMPACTION_PREFIX + Buffer.from(summary, "utf8").toString("base64");

function compactionSummary(item: ResponseInputItem): string {
  const content = item.encrypted_content;
  if (typeof content !== "string" || !content.startsWith(COMPACTION_PREFIX))
    throw new Error(
      "Unsupported Claude input: this history contains a compaction item another provider wrote, which Claude cannot read. Start a new task.",
    );
  return Buffer.from(
    content.slice(COMPACTION_PREFIX.length),
    "base64",
  ).toString("utf8");
}

/** Rejects unreadable compaction items before any Claude process starts. */
export function validateCompactionItems(request: ResponsesRequest): void {
  if (typeof request.input === "string") return;
  for (const item of request.input)
    if (item.type && COMPACTION_ITEM_TYPES.has(item.type))
      compactionSummary(item);
}

export type ToolDescriptor = {
  proxyName: string;
  name: string;
  namespace?: string;
  type: "function" | "custom" | "computer" | "tool_search";
  description?: string;
  contract?: unknown;
};

/**
 * Tools callable on this turn: the request's registry plus deferred tools that
 * Codex loaded through earlier tool_search results. Codex does not repeat
 * loaded tools in `request.tools`, so omitting them makes a found tool uncallable.
 */
export function requestTools(request: ResponsesRequest): ResponseTool[] {
  const loaded =
    typeof request.input === "string"
      ? []
      : request.input.flatMap((item) =>
          item.type === "tool_search_output" && Array.isArray(item.tools)
            ? (item.tools as ResponseTool[])
            : [],
        );
  return [...(request.tools ?? []), ...loaded];
}

export function toolDescriptors(tools: ResponseTool[]): ToolDescriptor[] {
  const descriptors: ToolDescriptor[] = [];
  for (const tool of tools) {
    if (tool.type === "tool_search") {
      descriptors.push({
        proxyName: TOOL_SEARCH_NAME,
        name: "tool_search",
        type: "tool_search",
        description:
          tool.description ??
          "Search deferred Codex tools and load matching tools for the next model call.",
        contract: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Specific names and capabilities of the deferred tools to load.",
            },
            limit: {
              type: "number",
              description: "Maximum tools to load. Defaults to 8.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      });
      continue;
    }
    if (tool.type === "namespace") {
      descriptors.push(
        ...toolDescriptors(tool.tools ?? []).map((nested) => ({
          ...nested,
          namespace: tool.name,
          proxyName: `${tool.name}.${nested.proxyName}`,
        })),
      );
      continue;
    }
    if (tool.type === "computer" || tool.type === "computer_use_preview") {
      descriptors.push({
        proxyName: COMPUTER_TOOL_NAME,
        name: "computer",
        type: "computer",
        description:
          "Control the Codex Desktop browser using visual computer actions.",
      });
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
  // The same tool can be loaded by several searches; keep its first definition.
  const unique = [
    ...new Map(
      descriptors.map((tool) => [tool.proxyName, tool] as const).reverse(),
    ).values(),
  ];
  return unique.sort((a, b) =>
    a.proxyName < b.proxyName ? -1 : a.proxyName > b.proxyName ? 1 : 0,
  );
}

export const textFromContent = (
  content: ResponseInputItem["content"],
): string => {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) =>
      ["input_text", "output_text", "text"].includes(part.type ?? ""),
    )
    .map((part) => part.text ?? "")
    .join("\n");
};

export const serializeItem = (item: ResponseInputItem): string => {
  if (item.type === "compaction_trigger") {
    return `<user>\n${SUMMARIZATION_PROMPT}\n\nPut the whole summary in text and leave tool_calls empty.\n</user>`;
  }
  if (item.type && COMPACTION_ITEM_TYPES.has(item.type)) {
    return `<user>\n${SUMMARY_PREFIX}\n${compactionSummary(item)}\n</user>`;
  }
  if (item.type === "tool_search_call") {
    return `<assistant_tool_call name=${JSON.stringify(TOOL_SEARCH_NAME)} call_id=${JSON.stringify(item.call_id)}>\n${JSON.stringify(item.arguments ?? {})}\n</assistant_tool_call>`;
  }
  if (item.type === "tool_search_output") {
    return `<tool_result call_id=${JSON.stringify(item.call_id)}>\n${JSON.stringify(item.tools ?? [])}\n</tool_result>`;
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    return `<assistant_tool_call name=${JSON.stringify(item.name)} call_id=${JSON.stringify(item.call_id)}>\n${item.arguments ?? item.input ?? "{}"}\n</assistant_tool_call>`;
  }
  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    const output =
      typeof item.output === "string"
        ? item.output
        : Array.isArray(item.output)
          ? toolOutputText(item.output)
          : JSON.stringify(item.output);
    return `<tool_result call_id=${JSON.stringify(item.call_id)}>\n${output ?? ""}\n</tool_result>`;
  }
  if (item.type === "computer_call") {
    return `<assistant_computer_call call_id=${JSON.stringify(item.call_id)}>\n${JSON.stringify(item.actions ?? item.action ?? {})}\n</assistant_computer_call>`;
  }
  if (item.type === "computer_call_output") {
    return `<computer_result call_id=${JSON.stringify(item.call_id)}>\n${screenshotUrls(item).length ? "Screenshot images are attached to this message." : JSON.stringify(item.output ?? "")}\n</computer_result>`;
  }
  const role =
    item.role ?? (item.type === "message" ? "user" : (item.type ?? "input"));
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
    {
      type: "drag",
      path: [
        { x: 100, y: 200 },
        { x: 200, y: 300 },
      ],
      keys: [],
    },
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
    contract ? `  argument_contract: ${stableJson(contract)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

export function requestToPrompt(request: ResponsesRequest): string {
  const input =
    typeof request.input === "string"
      ? `<user>\n${request.input}\n</user>`
      : request.input.map(serializeItem).join("\n\n");
  const tools = toolDescriptors(requestTools(request));
  const toolInstructions =
    tools.length === 0
      ? ""
      : `

<available_tools>
${tools.map(describeTool).join("\n")}
</available_tools>

You are the model inside the Codex agent loop. Return Codex-provided tool requests in tool_calls even when Claude has an equivalent built-in tool. For a function tool, arguments must be a JSON object encoded as a string. For a custom tool, arguments must be the exact raw input string. For ${TOOL_SEARCH_NAME}, arguments must be {"query":"specific tool names and capabilities","limit":8} encoded as JSON; use it before concluding that an instructed MCP, plugin, app, browser, node_repl, or cua_repl tool is unavailable. For ${COMPUTER_TOOL_NAME}, arguments must be one computer action object or {"actions":[...]} encoded as JSON. Use only listed tool names. You may return multiple independent tool calls. Do not claim a Codex tool succeeded until its tool result appears in the conversation. Images are attached directly to this message; inspect them without calling native tools.`;

  return [
    request.instructions
      ? `<instructions>\n${request.instructions}\n</instructions>`
      : "",
    toolInstructions,
    input,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The part of a request a live worker has not seen yet. Instructions and the
 * base tool registry were sent when the worker started; tools loaded by a new
 * tool_search are still described because they arrive inside `delta`. */
export function deltaRequest(
  request: ResponsesRequest,
  delta: ResponseInputItem[],
): ResponsesRequest {
  return { ...request, instructions: undefined, tools: [], input: delta };
}

/**
 * A conversation's stable context: its instructions, base tool registry, and
 * the context items Codex opens every task with. New workers get it in the
 * system prompt, which Claude Code ends with a cache breakpoint, so every task
 * and subagent that shares it reads it from cache. At the head of the first
 * user message no breakpoint ends it, and each new conversation rewrote it
 * (~80k tokens at the 1-hour cache-write price).
 */
export function systemContext(request: ResponsesRequest): string {
  const input = inputList(request);
  return requestToPrompt({
    ...request,
    input: input.slice(0, leadingContextCount(input)),
  });
}

/** A new worker's first message: the conversation after its system context. */
export function conversationRequest(
  request: ResponsesRequest,
): ResponsesRequest {
  const input = inputList(request);
  return deltaRequest(request, input.slice(leadingContextCount(input)));
}

const inputList = (request: ResponsesRequest): ResponseInputItem[] =>
  typeof request.input === "string"
    ? [{ role: "user", content: request.input }]
    : request.input;

// User messages Codex injects before the task's own prompt. Only exact openings
// count: treating a real prompt as context would hide nothing, but would give
// every task its own system prompt and cache entry.
const CONTEXT_OPENINGS = [
  "<environment_context>",
  "# AGENTS.md instructions",
  "<recommended_plugins>",
  "<user_instructions>",
];

function textParts(item: ResponseInputItem): string[] | undefined {
  if (item.type !== undefined && item.type !== "message") return undefined;
  if (typeof item.content === "string") return [item.content];
  const parts = item.content ?? [];
  if (parts.some((part) => part.type !== "input_text" && part.type !== "text"))
    return undefined;
  return parts.map((part) => part.text ?? "");
}

/**
 * How many leading items are Codex's task context: developer or system
 * messages followed by the user context message. The run ends after the last
 * user context message, so per-task items that follow it (a session-start
 * hook's output names its transcript path) stay in the conversation instead of
 * making each task's system prompt unique. Without a user context message the
 * run is not recognisably Codex's and nothing moves.
 */
export function leadingContextCount(input: ResponseInputItem[]): number {
  let end = 0;
  for (const [index, item] of input.entries()) {
    const parts = textParts(item);
    if (!parts) break;
    if (item.role === "developer" || item.role === "system") continue;
    if (
      item.role === "user" &&
      parts.length > 0 &&
      parts.every((text) =>
        CONTEXT_OPENINGS.some((opening) => text.trimStart().startsWith(opening)),
      )
    ) {
      end = index + 1;
      continue;
    }
    break;
  }
  // A first message needs something to say.
  return end < input.length ? end : 0;
}

// The schema is fixed for a worker's lifetime and heads its prompt-cache
// prefix, so it must not enumerate tool names: tool_search loads new tools
// mid-conversation. runClaude validates names and asks Claude to correct them.
export function outputSchema(tools: ResponseTool[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    text: {
      type: "string",
      description: "Assistant text to show before or instead of tool calls.",
    },
    tool_calls: { type: "array", maxItems: 0 },
  };

  if (tools.length > 0) {
    properties.tool_calls = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Exact tool name from <available_tools> or from a tool loaded by tool search (namespace.name).",
          },
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

// Tool results can be content parts. Their images travel as native image blocks
// (see prepareClaudePrompt); inlining the base64 as text costs several times more
// tokens than the image itself and hides it from Claude's vision.
export function toolOutputText(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return JSON.stringify(part);
      const { type, text, image_url } = part as ResponseContentPart;
      if (type === "input_image" && typeof image_url === "string")
        return "[Image attached to this message.]";
      if (
        ["input_text", "output_text", "text"].includes(type ?? "") &&
        typeof text === "string"
      )
        return text;
      return JSON.stringify(part);
    })
    .join("\n");
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

function contentImageUrls(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) =>
    part &&
    typeof part === "object" &&
    (part as ResponseContentPart).type === "input_image" &&
    typeof (part as ResponseContentPart).image_url === "string"
      ? [(part as ResponseContentPart).image_url as string]
      : [],
  );
}

/** Every image an item carries, in the order Claude receives them. */
export function itemImageUrls(item: ResponseInputItem): string[] {
  const toolOutput =
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output";
  return [
    ...screenshotUrls(item),
    ...contentImageUrls(item.content),
    ...(toolOutput ? contentImageUrls(item.output) : []),
  ];
}

export function requestImageCount(request: ResponsesRequest): number {
  if (!Array.isArray(request.input)) return 0;
  return request.input.reduce(
    (count, item) => count + itemImageUrls(item).length,
    0,
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

export type ClaudeInputBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

async function imageBlock(url: string): Promise<ClaudeInputBlock> {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url);
  if (match)
    return {
      type: "image",
      source: { type: "base64", media_type: match[1], data: match[2] },
    };
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Unable to fetch image: HTTP ${response.status}`);
  const media_type = (
    response.headers.get("content-type") ?? "image/png"
  ).split(";")[0];
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(media_type)
  )
    throw new Error("Unsupported image content type");
  return {
    type: "image",
    source: {
      type: "base64",
      media_type,
      data: Buffer.from(await response.arrayBuffer()).toString("base64"),
    },
  };
}

export async function prepareClaudePrompt(
  request: ResponsesRequest,
): Promise<{
  prompt: string;
  content: ClaudeInputBlock[];
  cleanup: () => Promise<void>;
}> {
  const prompt = requestToPrompt(request);
  const content: ClaudeInputBlock[] = [{ type: "text", text: prompt }];
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      for (const url of itemImageUrls(item)) {
        content.push({
          type: "text",
          text: `Image for ${item.call_id ? "tool result " + item.call_id : "conversation item " + request.input.indexOf(item)}:`,
        });
        content.push(await imageBlock(url));
      }
    }
  }
  return { prompt, content, cleanup: async () => {} };
}

export function validateRequest(value: unknown): ResponsesRequest {
  if (!value || typeof value !== "object")
    throw new Error("Request body must be a JSON object");
  const request = value as Partial<ResponsesRequest>;
  if (typeof request.model !== "string" || request.model.length === 0)
    throw new Error("model is required");
  if (typeof request.input !== "string" && !Array.isArray(request.input))
    throw new Error("input must be a string or array");
  if (request.tools && !Array.isArray(request.tools))
    throw new Error("tools must be an array");
  return request as ResponsesRequest;
}
