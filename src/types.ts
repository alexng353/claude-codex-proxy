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
  action?: unknown;
  actions?: unknown[];
  namespace?: string;
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
