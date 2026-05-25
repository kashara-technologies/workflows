// Web search server tool, executed on Anthropic's side.
//
// The model invokes this as a normal tool, but the request is fulfilled by
// Anthropic's infrastructure: we do not implement a handler. The orchestrator
// never sees a tool_use block for web_search; the API returns server-tool
// content blocks directly in the assistant message.

import type { ToolUnion } from '@anthropic-ai/sdk/resources/messages/messages.js';

/** Cap per request. Planner should not need more than this. */
const DEFAULT_MAX_USES = 5;

export function webSearchTool(opts: { maxUses?: number } = {}): ToolUnion {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: opts.maxUses ?? DEFAULT_MAX_USES,
  };
}
