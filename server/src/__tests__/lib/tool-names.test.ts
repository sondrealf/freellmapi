import { describe, it, expect } from 'vitest';
import {
  STRICT_TOOL_NAME,
  sanitizeToolName,
  sanitizeRequestToolNames,
  unmapResponseToolNames,
  unmapChunkToolNames,
  completionDefect,
} from '../../lib/tool-names.js';
import type { ChatMessage, ChatToolDefinition, ChatCompletionResponse } from '@freellmapi/shared/types.js';

// The live artifact that motivated all of this (free-mode, 2026-06-04): a
// free-tier model emitted a tool_call whose name was garbage prose, the
// client re-sent it in history every turn, and Copilot 400'd the whole
// conversation on `input[N].name` pattern checks from then on.
const LONGCAT_ARTIFACT = 'Step 5 — Write daily memory:<longcat_tool_call>Bash';

describe('sanitizeToolName', () => {
  it('passes compliant names through untouched', () => {
    for (const name of ['get_weather', 'mcp__gpt-researcher__check_health', 'Bash', '_private', 'a'.repeat(64)]) {
      expect(sanitizeToolName(name)).toBe(name);
    }
  });

  it('rewrites non-compliant names to the strict pattern', () => {
    for (const name of [LONGCAT_ARTIFACT, 'has space', 'dot.ted', 'a'.repeat(65), '9starts-with-digit', '-leading-dash', 'émoji✨']) {
      const out = sanitizeToolName(name);
      expect(out).toMatch(STRICT_TOOL_NAME);
      expect(out).not.toBe(name);
    }
  });

  it('is deterministic and idempotent', () => {
    const once = sanitizeToolName(LONGCAT_ARTIFACT);
    expect(sanitizeToolName(LONGCAT_ARTIFACT)).toBe(once);
    expect(sanitizeToolName(once)).toBe(once); // already compliant → unchanged
  });

  it('never collides distinct originals that flatten to the same stem', () => {
    expect(sanitizeToolName('tool.name')).not.toBe(sanitizeToolName('tool name'));
    expect(sanitizeToolName('tool.name')).not.toBe(sanitizeToolName('tool_name')); // vs a literal valid name
  });
});

describe('sanitizeRequestToolNames', () => {
  const validTool: ChatToolDefinition = {
    type: 'function',
    function: { name: 'get_weather', description: 'ok', parameters: {} },
  };

  it('returns inputs as-is (mapping null) when every name is compliant', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const out = sanitizeRequestToolNames([validTool], messages, 'auto');
    expect(out.mapping).toBeNull();
    expect(out.tools![0]).toBe(validTool);
    expect(out.messages).toBe(messages);
  });

  it('rewrites poisoned history tool_calls and keeps a reverse map', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: LONGCAT_ARTIFACT, arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok', name: LONGCAT_ARTIFACT },
    ];

    const out = sanitizeRequestToolNames([validTool], messages, undefined);
    expect(out.mapping).not.toBeNull();

    const sentName = (out.messages[1] as any).tool_calls[0].function.name;
    expect(sentName).toMatch(STRICT_TOOL_NAME);
    expect((out.messages[2] as any).name).toBe(sentName);
    expect(out.mapping!.reverse.get(sentName)).toBe(LONGCAT_ARTIFACT);

    // valid tool definition untouched; originals not mutated
    expect(out.tools![0].function.name).toBe('get_weather');
    expect((messages[1] as any).tool_calls[0].function.name).toBe(LONGCAT_ARTIFACT);
  });

  it('rewrites tool definitions and named tool_choice consistently', () => {
    const weird: ChatToolDefinition = { type: 'function', function: { name: 'weird name!', parameters: {} } };
    const out = sanitizeRequestToolNames([weird], [{ role: 'user', content: 'x' }], {
      type: 'function', function: { name: 'weird name!' },
    });
    const sentName = out.tools![0].function.name;
    expect(sentName).toMatch(STRICT_TOOL_NAME);
    expect((out.toolChoice as any).function.name).toBe(sentName);
  });
});

function makeResponse(toolName?: string, content: string | null = null): ChatCompletionResponse {
  return {
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{
      index: 0,
      finish_reason: toolName ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content,
        ...(toolName ? { tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: toolName, arguments: '{}' } }] } : {}),
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('unmap helpers', () => {
  it('restores original names on responses and chunks', () => {
    const out = sanitizeRequestToolNames(
      [{ type: 'function', function: { name: 'weird name!' } }],
      [{ role: 'user', content: 'x' }],
      undefined,
    );
    const sentName = out.tools![0].function.name;

    const res = unmapResponseToolNames(makeResponse(sentName), out.mapping);
    expect(res.choices[0].message.tool_calls![0].function.name).toBe('weird name!');

    const chunk = {
      id: 'x', object: 'chat.completion.chunk' as const, created: 0, model: 'm',
      choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: sentName, arguments: '' } }] } }],
    };
    expect(unmapChunkToolNames(chunk, out.mapping).choices[0].delta.tool_calls![0].function.name).toBe('weird name!');
  });

  it('is a no-op without a mapping', () => {
    const res = makeResponse('get_weather');
    expect(unmapResponseToolNames(res, null)).toBe(res);
  });
});

describe('completionDefect', () => {
  const allowed = new Set(['get_weather']);

  it('accepts a known tool_call', () => {
    expect(completionDefect(makeResponse('get_weather'), allowed)).toBeNull();
  });

  it('rejects hallucinated tool names', () => {
    expect(completionDefect(makeResponse('made_up_tool'), allowed)).toMatch(/^unknown_tool_name:/);
  });

  it('rejects tool_calls when no tools were offered', () => {
    expect(completionDefect(makeResponse('get_weather'), null)).toBe('unsolicited_tool_calls');
  });

  it('rejects empty completions (content:null, no tool_calls)', () => {
    expect(completionDefect(makeResponse(undefined, null), allowed)).toBe('empty_completion');
    expect(completionDefect(makeResponse(undefined, ''), null)).toBe('empty_completion');
  });

  it('accepts a normal text completion', () => {
    expect(completionDefect(makeResponse(undefined, 'It is 30C.'), allowed)).toBeNull();
    expect(completionDefect(makeResponse(undefined, 'hi'), null)).toBeNull();
  });
});
