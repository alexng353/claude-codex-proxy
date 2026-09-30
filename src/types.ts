export type ResponseTool = {
  type: string;
  name?: string;
  namespace?: string;
  description?: string;
  parameters?: unknown;
  format?: unknown;
  tools?: ResponseTool[];
  [key: string]: unknown;
};

export type ResponseContentPart = {
  type?: string;
  text?: string;
  image_url?: string;
  file_id?: string;
  [key: string]: unknown;
};

export type ResponseInputItem = {
  type?: string;
  role?: string;
  content?: string | ResponseContentPart[];
  name?: string;
  call_id?: string;
  arguments?: string;
  input?: string;
  output?: string | unknown;
  tools?: unknown[];
  execution?: string;
  status?: string;
  action?: unknown;
  actions?: unknown[];
  namespace?: string;
  /** Opaque on OpenAI compaction items; see request.ts for the proxy's own. */
  encrypted_content?: string;
  proxy_image_paths?: string[];
};

export type ResponsesRequest = {
  model: string;
  instructions?: string;
  input: string | ResponseInputItem[];
  tools?: ResponseTool[];
  tool_choice?: unknown;
  stream?: boolean;
  max_output_tokens?: number;
  reasoning?: { effort?: string };
  /** Codex thread key for durable account pinning and usage attribution. */
  prompt_cache_key?: string;
};

export type ClaudeResult = {
  type: "result";
  subtype: string;
  is_error: boolean;
  /** HTTP status of the API error behind an error result, e.g. 429. */
  api_error_status?: number | null;
  result?: string;
  structured_output?: {
    text: string;
    tool_calls: Array<{ name: string; arguments: string }>;
  };
  modelUsage?: Record<string, unknown>;
  duration_ms?: number;
  duration_api_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export type ProxyOutput = {
  text: string;
  toolCalls: Array<{ name: string; arguments: string; callId?: string }>;
  /** Set for a remote compaction request: the summary that replaces history. */
  compaction?: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Name of the Claude account that answered. */
  account?: string;
};
