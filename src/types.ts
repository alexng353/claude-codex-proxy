export type ResponseTool = {
  type: "function" | "custom";
  name: string;
  description?: string;
  parameters?: unknown;
  format?: unknown;
};

export type ResponseInputItem = {
  type?: string;
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  name?: string;
  call_id?: string;
  arguments?: string;
  input?: string;
  output?: string | unknown;
};

export type ResponsesRequest = {
  model: string;
  instructions?: string;
  input: string | ResponseInputItem[];
  tools?: ResponseTool[];
  tool_choice?: unknown;
  stream?: boolean;
  max_output_tokens?: number;
};

export type ClaudeResult = {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  structured_output?: {
    text: string;
    tool_calls: Array<{ name: string; arguments: string }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export type ProxyOutput = {
  text: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
};
