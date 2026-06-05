import { describe, it, expect } from 'vitest';
import { isRetryableError } from '../../routes/proxy.js';

describe('isRetryableError', () => {
  describe('413 Payload Too Large', () => {
    it('treats explicit "413" in the error message as retryable', () => {
      expect(isRetryableError(new Error('GitHub Models API error 413: Request body too large'))).toBe(true);
      expect(isRetryableError(new Error('Cloudflare API error 413: Payload Too Large'))).toBe(true);
    });

    it('treats common 413 phrasings (no status code) as retryable', () => {
      expect(isRetryableError(new Error('Payload Too Large'))).toBe(true);
      expect(isRetryableError(new Error('Request body too large for this model'))).toBe(true);
      expect(isRetryableError(new Error('Request entity too large'))).toBe(true);
      expect(isRetryableError(new Error('Content too large'))).toBe(true);
    });
  });

  describe('404 model removed / not found (the bug #66 fixes)', () => {
    it('treats explicit "404" in the error message as retryable', () => {
      expect(isRetryableError(new Error('OpenRouter API error 404: Provider returned error'))).toBe(true);
      expect(isRetryableError(new Error('Groq API error 404: model not found'))).toBe(true);
    });

    it('catches OpenRouter\'s "No endpoints found" phrasing for deprecated models', () => {
      expect(isRetryableError(new Error('No endpoints found for openrouter/minimax/minimax-m2.5:free'))).toBe(true);
    });

    it('catches bare "not found" phrasing (any provider, any case)', () => {
      expect(isRetryableError(new Error('Model not found'))).toBe(true);
      expect(isRetryableError(new Error('The requested model was not found'))).toBe(true);
    });
  });

  describe('existing categories still classify correctly', () => {
    it('429 / rate limits are retryable', () => {
      expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
      expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
      expect(isRetryableError(new Error('quota exhausted'))).toBe(true);
    });

    it('5xx and network errors are retryable', () => {
      expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
      expect(isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    });

    it('4xx auth/validation errors are NOT retryable', () => {
      expect(isRetryableError(new Error('401 Unauthorized'))).toBe(false);
      expect(isRetryableError(new Error('403 Forbidden'))).toBe(false);
      expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
      expect(isRetryableError(new Error('Invalid API key'))).toBe(false);
    });
  });

  describe('provider-incompat 400s advance the chain (live 2026-06-05 gpt-5-mini regression)', () => {
    it('unsupported-parameter 400s are retryable', () => {
      expect(isRetryableError(new Error(
        "GitHub Models API error 400: Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      ))).toBe(true);
      expect(isRetryableError(new Error('Unsupported parameter: temperature'))).toBe(true);
    });

    it('context-window overflow 400s are retryable (model-specific by definition)', () => {
      expect(isRetryableError(new Error(
        "SambaNova API error 400: This model's maximum context length is 32768 tokens. However, your messages resulted in 170661 tokens. Please reduce the length.",
      ))).toBe(true);
      expect(isRetryableError(new Error('context_length_exceeded'))).toBe(true);
      expect(isRetryableError(new Error('input exceeds the context window of this model'))).toBe(true);
    });

    it('generic 400s without an incompat signature remain NOT retryable', () => {
      expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
      expect(isRetryableError(new Error('API error 400: messages must not be empty'))).toBe(false);
    });

    it("OpenRouter's house upstream-failure wrapper is retryable (owl-alpha dead-head outage, 2026-06-05)", () => {
      expect(isRetryableError(new Error('OpenRouter API error 400: Provider returned error'))).toBe(true);
    });
  });
});
