import type { ResponseInputItem, ResponsesRequest, ResponseTool } from "./types";

const textFromContent = (content: ResponseInputItem["content"]): string => {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => ["input_text", "output_text", "text"].includes(part.type ?? ""))
    .map((part) => part.text ?? "")
    .join("\n");
};

const serializeItem = (item: ResponseInputItem): string => {
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    return `<assistant_tool_call name=${JSON.stringify(item.name)} call_id=${JSON.stringify(item.call_id)}>\n${item.arguments ?? item.input ?? "{}"}\n</assistant_tool_call>`;
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
    return `<tool_result call_id=${JSON.stringify(item.call_id)}>\n${output ?? ""}\n</tool_result>`;
  }
  const role = item.role ?? (item.type === "message" ? "user" : item.type ?? "input");
  return `<${role}>\n${textFromContent(item.content)}\n</${role}>`;
};

const describeTool = (tool: ResponseTool): string => {
  const contract = tool.type === "function" ? tool.parameters : tool.format;
  return [
    `- name: ${tool.name}`,
    `  type: ${tool.type}`,
    tool.description ? `  description: ${tool.description}` : "",
    contract ? `  argument_contract: ${JSON.stringify(contract)}` : "",
  ].filter(Boolean).join("\n");
};

export function requestToPrompt(request: ResponsesRequest): string {
  const input = typeof request.input === "string"
    ? `<user>\n${request.input}\n</user>`
    : request.input.map(serializeItem).join("\n\n");
  const tools = request.tools ?? [];
  const toolInstructions = tools.length === 0 ? "" : `

<available_tools>
${tools.map(describeTool).join("\n")}
</available_tools>

You are the model inside an agent loop. Do not execute tools yourself. When a tool is needed, return it in tool_calls. For a function tool, arguments must be a JSON object encoded as a string. For a custom tool, arguments must be the exact raw input string. Use only listed tool names. You may return multiple independent tool calls. Do not claim a tool succeeded until its tool_result appears in the conversation.`;

  return [
    request.instructions ? `<instructions>\n${request.instructions}\n</instructions>` : "",
    input,
    toolInstructions,
  ].filter(Boolean).join("\n\n");
}

export function outputSchema(tools: ResponseTool[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    text: { type: "string", description: "Assistant text to show before or instead of tool calls." },
    tool_calls: { type: "array", maxItems: 0 },
  };

  if (tools.length > 0) {
    properties.tool_calls = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", enum: tools.map((tool) => tool.name) },
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

export function validateRequest(value: unknown): ResponsesRequest {
  if (!value || typeof value !== "object") throw new Error("Request body must be a JSON object");
  const request = value as Partial<ResponsesRequest>;
  if (typeof request.model !== "string" || request.model.length === 0) throw new Error("model is required");
  if (typeof request.input !== "string" && !Array.isArray(request.input)) throw new Error("input must be a string or array");
  if (request.tools && !Array.isArray(request.tools)) throw new Error("tools must be an array");
  return request as ResponsesRequest;
}
