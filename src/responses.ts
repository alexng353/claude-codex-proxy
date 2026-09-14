import type { ProxyOutput, ResponsesRequest } from "./types";
import { COMPUTER_TOOL_NAME, toolDescriptors } from "./request";

type OutputItem = Record<string, unknown>;

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function outputItems(request: ResponsesRequest, output: ProxyOutput): OutputItem[] {
  const items: OutputItem[] = [];
  if (output.text) {
    items.push({
      id: id("msg"), type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", annotations: [], text: output.text }],
    });
  }
  const descriptors = toolDescriptors(request.tools ?? []);
  for (const call of output.toolCalls) {
    const descriptor = descriptors.find((tool) => tool.proxyName === call.name);
    if (call.name === COMPUTER_TOOL_NAME || descriptor?.type === "computer") {
      let action: unknown;
      try {
        action = JSON.parse(call.arguments);
      } catch {
        throw new Error("Computer tool arguments must be valid JSON");
      }
      const batched = action && typeof action === "object" && Array.isArray((action as { actions?: unknown }).actions)
        ? (action as { actions: unknown[] }).actions
        : undefined;
      items.push({
        id: id("cu"), type: "computer_call", status: "completed",
        call_id: id("call"), pending_safety_checks: [],
        ...(batched ? { actions: batched } : { action }),
      });
      continue;
    }
    if (descriptor?.type === "custom") {
      items.push({
        id: id("ctc"), type: "custom_tool_call", status: "completed",
        call_id: id("call"), name: descriptor.name, namespace: descriptor.namespace, input: call.arguments,
      });
      continue;
    }
    items.push({
      id: id("fc"), type: "function_call", status: "completed",
      call_id: id("call"), name: descriptor?.name ?? call.name, namespace: descriptor?.namespace, arguments: call.arguments,
    });
  }
  return items;
}

export function responseObject(request: ResponsesRequest, output: ProxyOutput) {
  return {
    id: id("resp"), object: "response", created_at: Math.floor(Date.now() / 1000),
    status: "completed", error: null, incomplete_details: null,
    model: request.model, output: outputItems(request, output), parallel_tool_calls: true,
    tool_choice: request.tool_choice ?? "auto", tools: request.tools ?? [],
    usage: {
      input_tokens: output.usage.inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: output.usage.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: output.usage.totalTokens,
    },
  };
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function streamResponse(response: ReturnType<typeof responseObject>): Response {
  const pending = { ...response, status: "in_progress", output: [], usage: null };
  let sequence = 0;
  const chunks = [sse("response.created", { type: "response.created", sequence_number: sequence++, response: pending })];
  response.output.forEach((item, outputIndex) => {
    const inProgress: OutputItem = { ...item, status: "in_progress" };
    if (item.type === "message") inProgress.content = [];
    if (item.type === "function_call") inProgress.arguments = "";
    if (item.type === "custom_tool_call") inProgress.input = "";
    chunks.push(sse("response.output_item.added", { type: "response.output_item.added", sequence_number: sequence++, output_index: outputIndex, item: inProgress }));
    if (item.type === "message") {
      const part = (item.content as Array<Record<string, unknown>>)[0];
      const emptyPart = { ...part, text: "" };
      chunks.push(sse("response.content_part.added", { type: "response.content_part.added", sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: 0, part: emptyPart }));
      chunks.push(sse("response.output_text.delta", { type: "response.output_text.delta", sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: 0, delta: part.text }));
      chunks.push(sse("response.output_text.done", { type: "response.output_text.done", sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: 0, text: part.text }));
      chunks.push(sse("response.content_part.done", { type: "response.content_part.done", sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: 0, part }));
    } else if (item.type === "function_call") {
      chunks.push(sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", sequence_number: sequence++, item_id: item.id, output_index: outputIndex, delta: item.arguments }));
      chunks.push(sse("response.function_call_arguments.done", { type: "response.function_call_arguments.done", sequence_number: sequence++, item_id: item.id, output_index: outputIndex, arguments: item.arguments }));
    } else if (item.type === "custom_tool_call") {
      chunks.push(sse("response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", sequence_number: sequence++, item_id: item.id, call_id: item.call_id, output_index: outputIndex, delta: item.input }));
      chunks.push(sse("response.custom_tool_call_input.done", { type: "response.custom_tool_call_input.done", sequence_number: sequence++, item_id: item.id, call_id: item.call_id, output_index: outputIndex, input: item.input }));
    }
    chunks.push(sse("response.output_item.done", { type: "response.output_item.done", sequence_number: sequence++, output_index: outputIndex, item }));
  });
  chunks.push(sse("response.completed", { type: "response.completed", sequence_number: sequence++, response }));
  chunks.push("data: [DONE]\n\n");
  return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}
