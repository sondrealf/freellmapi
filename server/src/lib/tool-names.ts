import crypto from 'crypto';
import type {
  ChatMessage,
  ChatToolDefinition,
  ChatToolChoice,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';

// Strictest tool-name constraint across the provider pool, used as the
// common denominator for outbound requests:
//   - GitHub Copilot (Responses API): ^[a-zA-Z0-9_-]+$  (observed 400
//     "string does not match pattern" on any other character)
//   - Google Gemini: must START with a letter or underscore; 64-char max
//   - OpenAI-compat providers: 64-char max
// A name passing this pattern is accepted by every provider we route to.
//
// Why this exists: free-tier models occasionally emit malformed tool_calls
// whose `name` is garbage prose (observed live 2026-06-04: a model produced
// "Step 5 — Write daily memory:<longcat_tool_call>Bash"). The client then
// faithfully re-sends that name in conversation history forever, and strict
// providers 400 the ENTIRE conversation from that point on — a poisoned
// history no restart of the proxy can fix. Sanitizing every tool name at
// the proxy boundary (definitions, history tool_calls, tool messages,
// tool_choice) keeps such conversations routable; the reverse map restores
// original names on the way out so clients never see the rewrite.
export const STRICT_TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

export interface ToolNameMapping {
  /** original name → sanitized name (only names that changed) */
  forward: Map<string, string>;
  /** sanitized name → original name */
  reverse: Map<string, string>;
}

export interface SanitizedRequest {
  tools?: ChatToolDefinition[];
  messages: ChatMessage[];
  toolChoice?: ChatToolChoice;
  /** null when every name was already compliant (the common case) */
  mapping: ToolNameMapping | null;
}

/**
 * Deterministically rewrite a tool name to satisfy STRICT_TOOL_NAME.
 * Compliant names pass through untouched. Non-compliant names get invalid
 * characters replaced with `_` plus a short content hash of the ORIGINAL
 * name, so distinct originals can never collide after the lossy replace and
 * the same original always maps to the same sanitized name across requests
 * (clients re-send history each turn — the mapping must be stateless).
 */
export function sanitizeToolName(name: string): string {
  if (STRICT_TOOL_NAME.test(name)) return name;
  const digest = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
  let stem = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 55);
  if (!/^[a-zA-Z_]/.test(stem)) stem = `t_${stem.slice(0, 53)}`;
  return `${stem}_${digest}`;
}

/**
 * Sanitize every tool name in an outbound request: tool definitions,
 * assistant-history tool_calls, tool-message `name` fields, and a named
 * tool_choice. Returns the (possibly rewritten) request pieces plus the
 * mapping needed to restore original names on the response. Input objects
 * are never mutated; untouched objects are returned as-is.
 */
export function sanitizeRequestToolNames(
  tools: ChatToolDefinition[] | undefined,
  messages: ChatMessage[],
  toolChoice: ChatToolChoice | undefined,
): SanitizedRequest {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const note = (name: string | undefined) => {
    if (!name || forward.has(name)) return;
    const sanitized = sanitizeToolName(name);
    if (sanitized !== name) {
      forward.set(name, sanitized);
      reverse.set(sanitized, name);
    }
  };

  for (const t of tools ?? []) note(t.function.name);
  for (const m of messages) {
    if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) note(tc.function.name);
    if (m.role === 'tool') note(m.name);
  }
  if (toolChoice && typeof toolChoice === 'object') note(toolChoice.function.name);

  if (forward.size === 0) return { tools, messages, toolChoice, mapping: null };

  const mapName = (n: string) => forward.get(n) ?? n;

  const newTools = tools?.map(t =>
    forward.has(t.function.name)
      ? { ...t, function: { ...t.function, name: mapName(t.function.name) } }
      : t,
  );

  const newMessages = messages.map(m => {
    if (m.role === 'assistant' && m.tool_calls?.some(tc => forward.has(tc.function.name))) {
      return {
        ...m,
        tool_calls: m.tool_calls.map(tc =>
          forward.has(tc.function.name)
            ? { ...tc, function: { ...tc.function, name: mapName(tc.function.name) } }
            : tc,
        ),
      };
    }
    if (m.role === 'tool' && m.name && forward.has(m.name)) {
      return { ...m, name: mapName(m.name) };
    }
    return m;
  });

  const newChoice = toolChoice && typeof toolChoice === 'object' && forward.has(toolChoice.function.name)
    ? { ...toolChoice, function: { name: mapName(toolChoice.function.name) } }
    : toolChoice;

  return { tools: newTools, messages: newMessages, toolChoice: newChoice, mapping: { forward, reverse } };
}

/** Restore original tool names on a non-streaming response (mutates in place). */
export function unmapResponseToolNames(
  response: ChatCompletionResponse,
  mapping: ToolNameMapping | null,
): ChatCompletionResponse {
  if (!mapping) return response;
  for (const choice of response.choices ?? []) {
    for (const tc of choice.message?.tool_calls ?? []) {
      const original = mapping.reverse.get(tc.function.name);
      if (original) tc.function.name = original;
    }
  }
  return response;
}

/** Restore original tool names on a streaming chunk (mutates in place). */
export function unmapChunkToolNames(
  chunk: ChatCompletionChunk,
  mapping: ToolNameMapping | null,
): ChatCompletionChunk {
  if (!mapping) return chunk;
  for (const choice of chunk.choices ?? []) {
    for (const tc of choice.delta?.tool_calls ?? []) {
      const original = mapping.reverse.get(tc.function.name);
      if (original) tc.function.name = original;
    }
  }
  return chunk;
}

/**
 * Decide whether a non-streaming completion is usable, or whether the
 * provider returned something that should fall through to the next model
 * in the chain. Returns a short defect code, or null when usable.
 *
 * Two defect families, both observed live on free-tier models (2026-06-04):
 *   - tool-call schema violations: tool_calls naming a function that was
 *     never offered (hallucinated / text-protocol artifacts like
 *     "<longcat_tool_call>"), or tool_calls when no tools were sent. Letting
 *     these through poisons the client's conversation history — the broken
 *     name gets re-sent every subsequent turn and strict providers 400 the
 *     whole conversation (see STRICT_TOOL_NAME).
 *   - empty completions: no tool_calls AND no content (kimi-k2.6 returned
 *     content:null finish:length on tool-shaped requests). Nothing for the
 *     client to act on — another provider may do better.
 *
 * `allowedToolNames` is the SANITIZED tool-definition name set actually sent
 * to the provider (null when the request had no tools) — call this BEFORE
 * un-mapping names back to originals.
 */
export function completionDefect(
  response: ChatCompletionResponse,
  allowedToolNames: Set<string> | null,
): string | null {
  const choice = response.choices?.[0];
  if (!choice) return 'no_choices';
  const toolCalls = choice.message?.tool_calls ?? [];

  if (toolCalls.length > 0) {
    if (!allowedToolNames) return 'unsolicited_tool_calls';
    for (const tc of toolCalls) {
      if (!tc.function?.name || !allowedToolNames.has(tc.function.name)) {
        return `unknown_tool_name:${tc.function?.name ?? '(missing)'}`;
      }
    }
    return null;
  }

  const content = choice.message?.content;
  const empty = content === null || content === undefined
    || (typeof content === 'string' && content.length === 0)
    || (Array.isArray(content) && content.length === 0);
  if (empty) return 'empty_completion';

  return null;
}
