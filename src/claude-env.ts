/** Subscription subprocesses must not inherit API billing or another login. */
export const STRIPPED_ENV = ["CLAUDECODE", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"];
