/**
 * Responses streaming events for a reply the hygiene gate writes itself
 * (message items only). Shared with the Codex model router so a locked GPT
 * turn renders exactly like a locked Claude turn, over SSE or websocket.
 */

/** The event sequence Codex expects for a completed response. */
export function responseEvents(response) {
  let sequence = 0;
  const events = [
    {
      type: "response.created",
      sequence_number: sequence++,
      response: { ...response, status: "in_progress", output: [], usage: null },
    },
  ];
  response.output.forEach((item, outputIndex) => {
    const base = { item_id: item.id, output_index: outputIndex, content_index: 0 };
    events.push({
      type: "response.output_item.added",
      sequence_number: sequence++,
      output_index: outputIndex,
      item: { ...item, status: "in_progress", content: [] },
    });
    for (const part of item.content ?? []) {
      events.push(
        { type: "response.content_part.added", sequence_number: sequence++, ...base, part: { ...part, text: "" } },
        { type: "response.output_text.delta", sequence_number: sequence++, ...base, delta: part.text },
        { type: "response.output_text.done", sequence_number: sequence++, ...base, text: part.text },
        { type: "response.content_part.done", sequence_number: sequence++, ...base, part },
      );
    }
    events.push({ type: "response.output_item.done", sequence_number: sequence++, output_index: outputIndex, item });
  });
  events.push({ type: "response.completed", sequence_number: sequence++, response });
  return events;
}

export function sseBody(response) {
  return (
    responseEvents(response)
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}

/**
 * Asks the proxy's gate about one request. Resolves to null (forward
 * unchanged) on any failure: a broken gate must not block GPT.
 */
export async function askGate(gateUrl, body, { timeoutMs = 90_000 } = {}) {
  try {
    const reply = await fetch(gateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!reply.ok) return null;
    const decision = await reply.json();
    if (decision?.action === "respond" && decision.response) return decision;
    if (decision?.action === "forward") return decision;
    return null;
  } catch {
    return null;
  }
}
