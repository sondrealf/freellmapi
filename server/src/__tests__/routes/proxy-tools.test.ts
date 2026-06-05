import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('Proxy tool-calling support', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_proxy_tool_test',
      label: 'proxy-tools',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes tools/tool_choice to provider and returns tool_calls', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-tool',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Karachi"}',
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      // No `model` → auto-route via fallback chain.
      messages: [{ role: 'user', content: 'What is the weather in Karachi?' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      }],
      tool_choice: 'required',
    }, authHeaders());

    expect(status).toBe(200);
    expect(providerBody.tools).toHaveLength(1);
    expect(providerBody.tool_choice).toBe('required');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
  });

  it('accepts assistant tool_calls + tool messages in follow-up turns', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-final',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'It is 30C in Karachi.',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [
        { role: 'user', content: 'Weather in Karachi?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_weather_1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"city":"Karachi"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_weather_1',
          content: '{"temp_c":30}',
        },
      ],
    }, authHeaders());

    expect(status).toBe(200);
    expect(providerBody.messages[1].role).toBe('assistant');
    expect(providerBody.messages[1].content).toBeNull();
    expect(providerBody.messages[1].tool_calls).toHaveLength(1);
    expect(providerBody.messages[2].role).toBe('tool');
    expect(providerBody.messages[2].tool_call_id).toBe('call_weather_1');
    expect(body.choices[0].message.content).toContain('30C');
  });

  it('sanitizes poisoned tool names in history and restores originals on the response', async () => {
    // Live free-mode artifact (2026-06-04): a model emitted this as a tool
    // name; once in history, pattern-strict providers 400 the conversation.
    const POISON = 'Step 5 — Write daily memory:<longcat_tool_call>Bash';
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        // Model calls the (sanitized) tool again — the proxy must translate
        // the name back to the original before answering the client.
        const sentName = providerBody.messages[1].tool_calls[0].function.name;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-poison',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_again',
                  type: 'function',
                  function: { name: sentName, arguments: '{}' },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [
        { role: 'user', content: 'continue the checklist' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_p1',
            type: 'function',
            function: { name: POISON, arguments: '{}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_p1', content: 'done' },
      ],
      tools: [{
        type: 'function',
        function: { name: POISON, parameters: { type: 'object', properties: {} } },
      }],
    }, authHeaders());

    expect(status).toBe(200);
    // Provider never saw the poisoned name — everywhere it appeared.
    const sentDefName = providerBody.tools[0].function.name;
    const sentCallName = providerBody.messages[1].tool_calls[0].function.name;
    expect(sentDefName).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);
    expect(sentCallName).toBe(sentDefName);
    // Client got the ORIGINAL name back.
    expect(body.choices[0].message.tool_calls[0].function.name).toBe(POISON);
  });

  it('falls back when a provider hallucinates an unknown tool name', async () => {
    const origFetch = global.fetch;
    let calls = 0;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        calls++;
        const bad = calls === 1;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: `chatcmpl-${calls}`,
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: bad
                ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'call_bad',
                    type: 'function',
                    function: { name: 'made_up_tool', arguments: '{}' },
                  }],
                }
                : {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'call_good',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"Karachi"}' },
                  }],
                },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Weather in Karachi?' }],
      tools: [{
        type: 'function',
        function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
      }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(headers.get('x-fallback-attempts')).toBe('1');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
  });

  it('falls back on empty completions (content:null, no tool_calls)', async () => {
    const origFetch = global.fetch;
    let calls = 0;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        calls++;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: `chatcmpl-${calls}`,
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: calls === 1
                ? { role: 'assistant', content: null }
                : { role: 'assistant', content: 'It is 30C in Karachi.' },
              finish_reason: calls === 1 ? 'length' : 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Weather in Karachi?' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(body.choices[0].message.content).toContain('30C');
  });
});
