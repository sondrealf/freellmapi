import crypto from 'crypto';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
import { contentToString } from '../lib/content.js';
import { getSessionToken, invalidateSession } from '../services/copilot-session.js';

/**
 * GitHub Copilot provider — Path B (opencode-style) auth.
 *
 * Auth model: the `apiKey` parameter is the raw GitHub OAuth access token
 * (`gho_...`) returned by the device flow. It's used directly as
 * `Authorization: Bearer ...` against `api.githubcopilot.com` — no
 * token-exchange / refresh dance. See `lib/copilot-auth.ts` for the flow
 * and the integration plan in vault for the rationale.
 *
 * Route selection: per-model. gpt-5-mini and gpt-5.4-mini speak the
 * Chat Completions wire format; gpt-5.2-codex speaks the Responses API
 * (different body + response shape). `shouldUseResponses` decides.
 *
 * Headers: every request carries 10 fixed headers + a fresh UUIDv4
 * `X-Request-Id`. `X-Initiator` is inferred from the message history
 * (`agent` if any prior assistant/tool message exists, else `user`).
 *
 * Out of scope (handled in v3 per the plan):
 *   - Claude family (/v1/messages route)
 *   - /models auto-discovery
 *   - Vision request handling
 *   - Token refresh scheduler (Path B uses long-lived OAuth tokens)
 *   - Tool-call fidelity on the Responses route (basic pass-through only)
 */

const COPILOT_DEFAULT_BASE_URL = 'https://api.githubcopilot.com';

/**
 * Acquire a session token + endpoint base URL for a request. Wraps
 * getSessionToken from the session cache and surfaces a clear error
 * if the proxy didn't thread the keyId through (which would be a
 * programming error, not a runtime condition).
 */
async function acquireSession(keyId: number | undefined, githubToken: string): Promise<{ sessionToken: string; endpointBase: string; keyId: number | undefined }> {
  if (!keyId) {
    // No keyId — happens on validateKey/health-check paths. Do a direct
    // one-shot exchange, no caching. Falls back to default base URL if
    // the endpoints.api field is missing from the response.
    const { sessionToken, endpointBase } = await directExchange(githubToken);
    return { sessionToken, endpointBase, keyId: undefined };
  }
  const got = await getSessionToken(keyId, githubToken);
  return { ...got, keyId };
}

async function directExchange(githubToken: string): Promise<{ sessionToken: string; endpointBase: string }> {
  // Lazy import to avoid a circular dependency with copilot-auth.
  const { exchangeToken } = await import('../lib/copilot-auth.js');
  const ex = await exchangeToken(githubToken);
  return { sessionToken: ex.sessionToken, endpointBase: ex.endpointBase || COPILOT_DEFAULT_BASE_URL };
}

// Header constants from ericc-ch/copilot-api `src/lib/api-config.ts`. Bump
// these in lockstep when GitHub tightens version checks (historically every
// 6 months or so — track opencode + ericc-ch upstream for the canonical bump).
const EDITOR_VERSION = 'vscode/1.107.0';
const EDITOR_PLUGIN_VERSION = 'copilot-chat/0.26.7';
const USER_AGENT = 'GitHubCopilotChat/0.26.7';

const RESPONSES_MODELS = new Set<string>([
  'gpt-5.2-codex',
  // gpt-5.4-mini: integration plan listed it under /chat/completions but
  // Copilot live-routes it to /responses with `unsupported_api_for_model`
  // on /chat/completions. Verified 2026-05-25 by probe against a Student
  // Pack session token.
  'gpt-5.4-mini',
  // The plan lists more (gpt-5.1, gpt-5.3-codex, etc.) — left out of this
  // initial set per commander scope. Add ids here as they're enabled.
]);

function shouldUseResponses(modelId: string): boolean {
  return RESPONSES_MODELS.has(modelId);
}

function inferInitiator(messages: ChatMessage[]): 'user' | 'agent' {
  for (const m of messages) {
    if (m.role === 'assistant' || m.role === 'tool') return 'agent';
  }
  return 'user';
}

function buildHeaders(token: string, messages: ChatMessage[]): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Copilot-Integration-Id': 'vscode-chat',
    'Editor-Version': EDITOR_VERSION,
    'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
    'User-Agent': USER_AGENT,
    'Openai-Intent': 'conversation-panel',
    'X-GitHub-Api-Version': '2025-04-01',
    'X-Request-Id': crypto.randomUUID(),
    'X-Initiator': inferInitiator(messages),
  };
}

export class GitHubCopilotProvider extends BaseProvider {
  readonly platform: Platform = 'github-copilot';
  readonly name = 'GitHub Copilot';
  private readonly timeoutMs = 60000;

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    if (shouldUseResponses(modelId)) {
      return this.responsesCompletion(apiKey, messages, modelId, options, false);
    }
    return this.chatCompletionRoute(apiKey, messages, modelId, options, false);
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    if (shouldUseResponses(modelId)) {
      yield* this.streamResponsesRoute(apiKey, messages, modelId, options);
      return;
    }
    yield* this.streamChatRoute(apiKey, messages, modelId, options);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Run a one-off Step-3 exchange. A successful exchange proves both
    // that the gho_ token still has Copilot access AND that GitHub
    // recognises it for the inference endpoints. Cheaper + more
    // diagnostic than hitting /models directly.
    try {
      await directExchange(apiKey);
      return true;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('(401)') || msg.includes('(403)')) return false;
      // Network blip etc. — don't mark the key invalid on a transient.
      // health.ts already swallows transport errors without flipping
      // the status; propagating throws would respect that behaviour
      // but the existing contract returns a boolean. Treat unknown
      // failures as "not invalid" so we don't disable a good key.
      return true;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // /chat/completions route
  // ────────────────────────────────────────────────────────────────────

  private async chatCompletionRoute(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream: boolean,
  ): Promise<ChatCompletionResponse> {
    const { sessionToken, endpointBase, keyId } = await acquireSession(options?.keyId, apiKey);
    const body = this.buildChatBody(messages, modelId, options, stream);
    const res = await this.fetchWithTimeout(`${endpointBase}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(sessionToken, messages),
      body: JSON.stringify(body),
    }, this.timeoutMs);

    if (!res.ok) {
      // 401 likely means the cached session token raced ahead of GitHub's
      // own clock or the refresh timer hasn't fired yet. Drop the cache so
      // the next attempt re-exchanges, then bubble up — the router's
      // retry loop will try again on a different model.
      if (res.status === 401 && keyId !== undefined) invalidateSession(keyId);
      const err = await res.text().catch(() => '');
      throw new Error(`GitHub Copilot API error ${res.status}: ${err.slice(0, 500)}`);
    }
    const data = await res.json() as ChatCompletionResponse;
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  private async *streamChatRoute(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { sessionToken, endpointBase, keyId } = await acquireSession(options?.keyId, apiKey);
    const body = this.buildChatBody(messages, modelId, options, true);
    const res = await this.fetchWithTimeout(`${endpointBase}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(sessionToken, messages),
      body: JSON.stringify(body),
    }, this.timeoutMs);

    if (!res.ok) {
      if (res.status === 401 && keyId !== undefined) invalidateSession(keyId);
      const err = await res.text().catch(() => '');
      throw new Error(`GitHub Copilot API error ${res.status}: ${err.slice(0, 500)}`);
    }
    yield* parseChatSse(res);
  }

  private buildChatBody(
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    // opencode confirmed that Copilot's GPT route rejects `max_tokens`; the
    // documented per-call cap is the model's own context window anyway,
    // and the public Models REST API's 4-8k clamp does NOT apply here. So
    // we strip it for gpt-* ids. (Anthropic / Gemini routes still want
    // max_tokens; those aren't in scope yet but the check would gate
    // there too once added.)
    const isGpt = modelId.toLowerCase().startsWith('gpt-');
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.tools) body.tools = options.tools;
    if (options?.tool_choice !== undefined) body.tool_choice = options.tool_choice;
    if (options?.parallel_tool_calls !== undefined) body.parallel_tool_calls = options.parallel_tool_calls;
    if (!isGpt && options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;
    return body;
  }

  // ────────────────────────────────────────────────────────────────────
  // /responses route (OpenAI Responses API — different body shape)
  // ────────────────────────────────────────────────────────────────────

  private async responsesCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    _stream: boolean,
  ): Promise<ChatCompletionResponse> {
    const { sessionToken, endpointBase, keyId } = await acquireSession(options?.keyId, apiKey);
    const body = this.buildResponsesBody(messages, modelId, options, false);
    const res = await this.fetchWithTimeout(`${endpointBase}/responses`, {
      method: 'POST',
      headers: buildHeaders(sessionToken, messages),
      body: JSON.stringify(body),
    }, this.timeoutMs);

    if (!res.ok) {
      if (res.status === 401 && keyId !== undefined) invalidateSession(keyId);
      const err = await res.text().catch(() => '');
      throw new Error(`GitHub Copilot API error ${res.status}: ${err.slice(0, 500)}`);
    }
    const data = await res.json() as ResponsesApiResponse;
    return responsesToChatCompletion(data, modelId, this.platform);
  }

  private async *streamResponsesRoute(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { sessionToken, endpointBase, keyId } = await acquireSession(options?.keyId, apiKey);
    const body = this.buildResponsesBody(messages, modelId, options, true);
    const res = await this.fetchWithTimeout(`${endpointBase}/responses`, {
      method: 'POST',
      headers: buildHeaders(sessionToken, messages),
      body: JSON.stringify(body),
    }, this.timeoutMs);

    if (!res.ok) {
      if (res.status === 401 && keyId !== undefined) invalidateSession(keyId);
      const err = await res.text().catch(() => '');
      throw new Error(`GitHub Copilot API error ${res.status}: ${err.slice(0, 500)}`);
    }
    yield* parseResponsesSse(res, modelId);
  }

  private buildResponsesBody(
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    // Responses API conversation shape:
    //   - `instructions`: system content (single string, joined across turns).
    //   - `input`: array of typed items. Three kinds we emit:
    //       1. {role: user|assistant, content: [{type: input_text|output_text, text}]}
    //          — normal text messages
    //       2. {type: 'function_call', call_id, name, arguments}
    //          — a prior assistant turn that called a tool (translated from
    //          Chat Completions `assistant.tool_calls`)
    //       3. {type: 'function_call_output', call_id, output}
    //          — the tool-result message (translated from `role: 'tool'`)
    //
    // Without (2) and (3) the upstream model loses the context that it had
    // already called a tool and what came back, which breaks multi-turn
    // tool conversations. Without sending `tools` in the body the model
    // also can't emit fresh tool_calls. Both fidelity gaps were the cause
    // of free-mode silently text-replying through gpt-5.2-codex / gpt-5.4-mini
    // — fixed below.
    type InputItem =
      | { role: string; content: Array<{ type: string; text: string }> }
      | { type: 'function_call'; call_id: string; name: string; arguments: string }
      | { type: 'function_call_output'; call_id: string; output: string };

    const systemTexts: string[] = [];
    const input: InputItem[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        const t = contentToString(m.content);
        if (t) systemTexts.push(t);
        continue;
      }

      if (m.role === 'tool') {
        // Chat Completions `role: 'tool'` → Responses `function_call_output`.
        // The call_id ties this back to the assistant's prior function_call.
        if (m.tool_call_id) {
          input.push({
            type: 'function_call_output',
            call_id: m.tool_call_id,
            output: contentToString(m.content),
          });
        }
        continue;
      }

      if (m.role === 'assistant') {
        // Emit any prior tool_calls as Responses `function_call` items.
        if (m.tool_calls?.length) {
          for (const tc of m.tool_calls) {
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          }
        }
        // Emit any text content alongside the tool_calls.
        const text = contentToString(m.content);
        if (text) {
          input.push({
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          });
        }
        continue;
      }

      // user (default)
      const text = contentToString(m.content);
      if (!text) continue;
      input.push({
        role: 'user',
        content: [{ type: 'input_text', text }],
      });
    }

    const body: Record<string, unknown> = {
      model: modelId,
      input,
      stream,
    };
    if (systemTexts.length > 0) body.instructions = systemTexts.join('\n\n');
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.max_tokens !== undefined) body.max_output_tokens = options.max_tokens;

    // Tool support (Responses API uses a FLAT tool shape — `type`, `name`,
    // `description`, `parameters` at the top level, not nested under a
    // `function` field the way Chat Completions does).
    if (options?.tools?.length) {
      body.tools = options.tools.map(toResponsesTool);
    }
    if (options?.tool_choice !== undefined) {
      body.tool_choice = toResponsesToolChoice(options.tool_choice);
    }
    if (options?.parallel_tool_calls !== undefined) {
      body.parallel_tool_calls = options.parallel_tool_calls;
    }

    return body;
  }
}

// Chat Completions tool shape → Responses API tool shape.
// CC: { type: 'function', function: { name, description, parameters } }
// RA: { type: 'function', name, description, parameters }
function toResponsesTool(tool: ChatToolDefinition): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: 'function',
    name: tool.function.name,
  };
  if (tool.function.description !== undefined) result.description = tool.function.description;
  if (tool.function.parameters !== undefined) result.parameters = tool.function.parameters;
  if (tool.function.strict !== undefined) result.strict = tool.function.strict;
  return result;
}

// Chat Completions tool_choice → Responses tool_choice. The named-function
// form is also flattened.
function toResponsesToolChoice(choice: ChatToolChoice): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.function.name };
}

// ────────────────────────────────────────────────────────────────────────
// SSE parsing for the Chat Completions route — same line shape as OpenAI
// (`data: <json>\n\n`, terminated by `data: [DONE]`).
// ────────────────────────────────────────────────────────────────────────

async function* parseChatSse(res: Response): AsyncGenerator<ChatCompletionChunk> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data) as ChatCompletionChunk;
      } catch {
        // skip malformed chunk
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Responses API — non-stream shape + SSE stream shape.
// The non-stream response looks like:
//   { id, object: 'response', output: [{ type: 'message',
//     content: [{ type: 'output_text', text: '...' }] }],
//     usage: { input_tokens, output_tokens, total_tokens } }
// The stream emits typed events with a leading `event:` line and a
// `data: <json>` line. We only care about `response.output_text.delta`
// (text increments) and `response.completed` (final usage).
// ────────────────────────────────────────────────────────────────────────

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}
interface ResponsesContentBlock {
  type: string;
  text?: string;
}
interface ResponsesOutputItem {
  type: string;
  // type === 'message'
  content?: ResponsesContentBlock[];
  // type === 'function_call'
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}
interface ResponsesApiResponse {
  id?: string;
  created_at?: number;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
}

function responsesToChatCompletion(
  data: ResponsesApiResponse,
  modelId: string,
  platform: Platform,
): ChatCompletionResponse {
  // The Responses API output array can mix `message` items (text) and
  // `function_call` items (tool invocations). Extract both — text goes
  // into the assistant message content; function_calls translate to the
  // Chat-Completions `tool_calls` shape so OpenAI-compatible clients
  // (including the CCR Anthropic adapter) can route them.
  let text = '';
  const toolCalls: ChatToolCall[] = [];

  for (const item of data.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
      }
    } else if (item.type === 'function_call') {
      // Responses uses `call_id` to tie a call to its later
      // `function_call_output`. Chat Completions clients use `id` for the
      // same purpose. Carry call_id forward as the OpenAI id so downstream
      // tool_result messages can reference it.
      const callId = item.call_id ?? item.id ?? `call_${crypto.randomUUID()}`;
      toolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: item.name ?? '',
          arguments: item.arguments ?? '',
        },
      });
    }
  }

  const hasToolCalls = toolCalls.length > 0;

  return {
    id: data.id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: data.created_at ?? Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: hasToolCalls
        ? { role: 'assistant', content: text || null, tool_calls: toolCalls }
        : { role: 'assistant', content: text },
      finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: data.usage?.total_tokens
        ?? ((data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)),
    },
    _routed_via: { platform, model: modelId },
  };
}

async function* parseResponsesSse(res: Response, modelId: string): AsyncGenerator<ChatCompletionChunk> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buffer = '';
  const chunkId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  // Tool-call state machine. Responses API streams function-call output
  // items via three event types:
  //   - response.output_item.added            (item: {type: 'function_call', id, call_id, name, arguments: ''}, output_index)
  //   - response.function_call_arguments.delta (item_id, delta)
  //   - response.function_call_arguments.done  (item_id, arguments)
  //   - response.output_item.done             (item: {..., arguments: <full>}, output_index)
  //
  // We translate to OpenAI Chat Completions streaming format: one chunk
  // emits the tool_call header (id+name) at `index = N`; subsequent
  // chunks emit argument deltas at the same index. The final
  // `response.completed` event emits the terminator chunk with
  // `finish_reason = 'tool_calls'` when any tool calls fired.
  // Track in-flight function_call output items. The upstream
  // github-copilot Responses-API encrypts per-event metadata, so the
  // `item_id` on `*.delta`/`*.done` events is NOT the same string as
  // the `item.id` on the matching `output_item.added` event. We can't
  // correlate by id; instead, track a single "current open function
  // call" — github-copilot emits the events sequentially, so all
  // delta/done events between an `output_item.added` (function_call)
  // and the next `output_item.done` belong to that call.
  type Slot = { index: number; callId: string; argsStreamed: boolean };
  const openSlots: Slot[] = [];
  let currentSlot: Slot | undefined;
  let nextToolIndex = 0;
  let sawToolCalls = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const evt of events) {
      // Each event block has multiple `key: value` lines. We only need
      // the `data:` line — the `event:` type is also present in `data`'s
      // `type` field, so reading the JSON is sufficient.
      let dataLine = '';
      for (const line of evt.split('\n')) {
        if (line.startsWith('data: ')) {
          dataLine = line.slice(6);
          break;
        }
      }
      if (!dataLine || dataLine === '[DONE]') continue;
      let payload: any;
      try {
        payload = JSON.parse(dataLine);
      } catch {
        continue;
      }

      // Plain text delta — unchanged from the original handler.
      if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: payload.delta },
            finish_reason: null,
          }],
        };
        continue;
      }

      // New output item — only act on function_call kind. Emit the
      // tool_call header chunk so the client sees the call name/id
      // before any argument deltas arrive. Track this as the "current
      // open function_call" so the upcoming delta events route to it
      // (the upstream's per-event item_id is encrypted differently each
      // time so we can't lookup-by-id; positional state is the only
      // reliable correlation).
      if (payload.type === 'response.output_item.added' && payload.item?.type === 'function_call') {
        const callId = payload.item.call_id ?? `fc_${crypto.randomUUID()}`;
        const index = nextToolIndex++;
        const slot: Slot = { index, callId, argsStreamed: false };
        openSlots.push(slot);
        currentSlot = slot;
        sawToolCalls = true;
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index,
                id: callId,
                type: 'function',
                function: { name: payload.item.name ?? '', arguments: payload.item.arguments ?? '' },
              }],
            },
            finish_reason: null,
          }] as any,
        };
        continue;
      }

      // Incremental function-call arguments. Route to the current open
      // slot (set by the matching output_item.added above). Different
      // upstream builds use slightly different keys for the delta
      // payload — accept either `delta` (string) or `arguments_delta`.
      if (payload.type === 'response.function_call_arguments.delta' && currentSlot) {
        const argDelta = typeof payload.delta === 'string' ? payload.delta
          : typeof payload.arguments_delta === 'string' ? payload.arguments_delta : '';
        if (argDelta) {
          currentSlot.argsStreamed = true;
          yield {
            id: chunkId,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: currentSlot.index,
                  function: { arguments: argDelta },
                }],
              },
              finish_reason: null,
            }] as any,
          };
        }
        continue;
      }

      // Belt-and-suspenders: if the upstream skipped per-token deltas
      // and emits the final args only once on `.arguments.done`, route
      // to the current slot. Only emit if nothing has been streamed yet
      // — otherwise the `.done` repeat would double-count args.
      if (payload.type === 'response.function_call_arguments.done' && currentSlot) {
        const argsFull = typeof payload.arguments === 'string' ? payload.arguments : '';
        if (!currentSlot.argsStreamed && argsFull) {
          currentSlot.argsStreamed = true;
          yield {
            id: chunkId,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: currentSlot.index,
                  function: { arguments: argsFull },
                }],
              },
              finish_reason: null,
            }] as any,
          };
        }
        continue;
      }

      // Item finished. If it's a function_call and nothing has been
      // streamed for the current open slot, emit the complete args from
      // the item payload now (some upstreams skip both per-token deltas
      // AND `.arguments.done`, only carrying the final args on
      // `output_item.done`). Then clear `currentSlot` so the next
      // function_call gets its own slot.
      if (payload.type === 'response.output_item.done' && payload.item?.type === 'function_call') {
        const argsFull = typeof payload.item?.arguments === 'string' ? payload.item.arguments : '';
        if (currentSlot && !currentSlot.argsStreamed && argsFull) {
          currentSlot.argsStreamed = true;
          yield {
            id: chunkId,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: currentSlot.index,
                  function: { arguments: argsFull },
                }],
              },
              finish_reason: null,
            }] as any,
          };
        }
        currentSlot = undefined;
        continue;
      }

      // End of stream. If any tool_calls fired during this turn,
      // OpenAI's contract is `finish_reason = 'tool_calls'`; otherwise
      // `stop` (the existing behaviour for pure-text turns).
      if (payload.type === 'response.completed') {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
          }],
        };
        continue;
      }
    }
  }
}
