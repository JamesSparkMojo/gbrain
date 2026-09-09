/**
 * #4863 — facts extraction asks openai-compatible backends that honor
 * json_schema (Ollama) for schema-constrained output.
 *
 * Small local models emit malformed JSON a fraction of the time on a
 * prompt-only extraction. Ollama enforces `response_format: json_schema`
 * server-side (grammar-constrained decoding, model-independent), so the
 * extractor threads its schema through `ChatOpts.responseSchema` and chat()
 * attaches it as the AI SDK `output` for recipes that declare
 * `supports_structured_outputs` under the openai-compatible implementation.
 *
 * Pinned through the generateText transport seam — the chat transport
 * short-circuits before the SDK call, so it cannot observe `output`:
 *   - ollama: `output` is attached, its responseFormat is the facts schema,
 *     and the reply text still flows through the extractor's own parser.
 *   - the Output spec is TOLERANT: parseCompleteOutput hands the raw text
 *     back instead of throwing NoObjectGeneratedError (generateText parses
 *     eagerly on finishReason 'stop'), so a malformed reply stays a
 *     recoverable malformed_output for the extractor's retry lane.
 *   - the #2113 truncation retry re-sends at 2x with `output` still attached.
 *   - native anthropic and an openai-compatible recipe WITHOUT the flag get
 *     no `output` at all (lanes byte-identical to before).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setGenerateTextTransportForTests,
} from '../src/core/ai/gateway.ts';
import { extractFactsFromTurnWithOutcome } from '../src/core/facts/extract.ts';

const OLLAMA = 'ollama:gemma3:4b';
const GOOD_JSON = '{"facts":[{"fact":"user gave up alcohol","kind":"commitment",' +
  '"entity":null,"confidence":1.0,"notability":"high",' +
  '"metric":null,"value":null,"unit":null,"period":null}]}';

function sdkResult(text: string, finishReason: 'stop' | 'length' = 'stop'): any {
  return { content: [{ type: 'text', text }], finishReason, usage: { inputTokens: 5, outputTokens: 5 } };
}

function extract(model: string) {
  return extractFactsFromTurnWithOutcome({ turnText: 'I gave up alcohol.', source: 'test:structured', model });
}

beforeEach(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
});

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

// Shard hygiene (same rationale as facts-extract-truncation.test.ts): restore
// the legacy 1536-d embedding pin so later fresh-schema files in this shard
// don't inherit a dimensionless gateway.
afterAll(() => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

describe('facts extraction — structured output on ollama (#4863)', () => {
  test('chat() attaches the facts schema as the SDK `output`; facts still parse from the reply text', async () => {
    configureGateway({ chat_model: OLLAMA, env: {} });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => { calls.push(args); return sdkResult(GOOD_JSON); });

    const outcome = await extract(OLLAMA);

    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBeDefined();
    const rf = await calls[0].output.responseFormat;
    expect(rf.type).toBe('json');
    expect(rf.name).toBe('facts_extraction');
    expect(rf.schema.required).toEqual(['facts']);
    expect(rf.schema.additionalProperties).toBe(false);
    const item = rf.schema.properties.facts.items;
    expect(item.required).toEqual(['fact', 'kind']);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.kind.enum).toContain('commitment');
    expect(item.properties.notability.enum).toEqual(['high', 'medium', 'low']);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.facts).toHaveLength(1);
      expect(outcome.facts[0]!.kind).toBe('commitment');
    }
  });

  test('the Output spec is tolerant: malformed text is handed back, not thrown, so the extractor retry lane runs', async () => {
    configureGateway({ chat_model: OLLAMA, env: {} });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      calls.push(args);
      return sdkResult(calls.length === 1 ? 'not json' : GOOD_JSON);
    });

    const outcome = await extract(OLLAMA);

    // Output.object would throw NoObjectGeneratedError inside generateText on
    // the first reply; the tolerant spec returns the text untouched.
    await expect(calls[0].output.parseCompleteOutput({ text: 'not json' }, {} as any)).resolves.toBe('not json');
    expect(calls).toHaveLength(2);
    expect(calls[1].output).toBeDefined();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.facts).toHaveLength(1);
  });

  test('#2113 truncation retry re-sends at double the cap with `output` still attached', async () => {
    configureGateway({ chat_model: OLLAMA, env: {} });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      calls.push(args);
      return calls.length === 1
        ? sdkResult('{"facts":[{"fact":"user gave up alco', 'length')
        : sdkResult(GOOD_JSON);
    });

    const outcome = await extract(OLLAMA);

    expect(calls).toHaveLength(2);
    expect(calls[1].maxOutputTokens).toBe(calls[0].maxOutputTokens * 2);
    expect(calls[1].output).toBeDefined();
    expect(outcome.ok).toBe(true);
  });
});

describe('facts extraction — every other lane is unchanged', () => {
  test('native anthropic: no `output` on the SDK call', async () => {
    const model = 'anthropic:claude-sonnet-4-6';
    configureGateway({ chat_model: model, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => { calls.push(args); return sdkResult(GOOD_JSON); });

    const outcome = await extract(model);

    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBeUndefined();
    expect(outcome.ok).toBe(true);
  });

  test('openai-compatible recipe that does NOT declare structured outputs: no `output` either', async () => {
    const model = 'deepseek:deepseek-chat';
    configureGateway({ chat_model: model, env: { DEEPSEEK_API_KEY: 'sk-fake' } });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => { calls.push(args); return sdkResult(GOOD_JSON); });

    const outcome = await extract(model);

    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBeUndefined();
    expect(outcome.ok).toBe(true);
  });
});
