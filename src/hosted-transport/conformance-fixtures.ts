/**
 * Diagnostic fixtures for the official MCP conformance suite
 * (`@modelcontextprotocol/conformance`). The suite certifies protocol
 * behaviour by calling tools and prompts with well-known names
 * (`test_simple_text`, `test_missing_capability`, ...); these are those
 * fixtures, implemented exactly as each scenario's "Server Implementation
 * Requirements" section specifies.
 *
 * HARNESS-ONLY. They are merged into the stateless surface solely when
 * `HOSTED_CONFORMANCE_FIXTURES=1` (`env.ts`, set by
 * `scripts/conformance-hosted.ts`), never in production. They hold no
 * credentials, reach no adapter, make no network call — each returns a
 * canned result so the PROTOCOL layer (`stateless-handler.ts`) is what the
 * suite exercises.
 */

import type { StatelessSurface, StatelessToolDefinition } from './stateless-handler.js';

const NO_ARGS_SCHEMA = { type: 'object', properties: {} } as const;

/** 1x1 transparent PNG — the smallest honest "an image" there is. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 44-byte silent WAV header — a valid, zero-sample audio file. */
const TINY_WAV_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function textResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }] };
}

export function buildConformanceFixtureTools(): StatelessToolDefinition[] {
  return [
    {
      // tools-call-simple-text: returns one text content block.
      name: 'test_simple_text',
      description: 'Conformance fixture: returns a plain text result.',
      inputSchema: { ...NO_ARGS_SCHEMA },
      call: async () => textResult('Hello from affiliate-mcp-hosted conformance fixtures.'),
    },
    {
      // tools-call-error: a tool that ran and reports failure via isError.
      name: 'test_error_handling',
      description: 'Conformance fixture: always returns a tool-level error result.',
      inputSchema: { ...NO_ARGS_SCHEMA },
      call: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'Deliberate fixture error (tools-call-error scenario).' }],
      }),
    },
    {
      // server-stateless (SEP-2575): requires the `sampling` client
      // capability; the HANDLER refuses with -32021 before this runs when the
      // capability is undeclared.
      name: 'test_missing_capability',
      description: 'Conformance fixture: requires the sampling client capability.',
      inputSchema: { ...NO_ARGS_SCHEMA },
      requiredClientCapabilities: ['sampling'],
      call: async () => textResult('Client declared the sampling capability.'),
    },
    {
      // server-stateless: no notifications/message may appear when the
      // request set no log level. A canned result emits nothing, which is
      // exactly the requirement.
      name: 'test_logging_tool',
      description: 'Conformance fixture: performs work without emitting log notifications.',
      inputSchema: { ...NO_ARGS_SCHEMA },
      call: async () => textResult('Completed without logging.'),
    },
    {
      // server-stateless: the response stream must contain only results and
      // notifications, never independent server-initiated requests. A single
      // complete result satisfies that; this server does not initiate
      // elicitation (it advertises no such need).
      name: 'test_streaming_elicitation',
      description: 'Conformance fixture: completes in one round trip without server-initiated requests.',
      inputSchema: { ...NO_ARGS_SCHEMA },
      call: async () => textResult('Completed without server-initiated requests.'),
    },
    {
      // server-stateless subscription checks: this server advertises no
      // listChanged/subscribe capability, so those checks self-skip; the
      // trigger tool still exists so the probe call itself succeeds.
      name: 'test_trigger_tool_change',
      description: 'Conformance fixture: acknowledges a tool-change trigger (no-op).',
      inputSchema: { ...NO_ARGS_SCHEMA },
      call: async () => textResult('No dynamic tool list on this server; nothing changed.'),
    },
    {
      // tools-call-image: one image content block.
      name: 'test_image_content',
      description: 'Conformance fixture: returns an image content block.',
      inputSchema: { ...NO_ARGS_SCHEMA },
      call: async () => ({ content: [{ type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }] }),
    },
    {
      // tools-call-audio: one audio content block.
      name: 'test_audio_content',
      description: 'Conformance fixture: returns an audio content block.',
      inputSchema: { ...NO_ARGS_SCHEMA },
      call: async () => ({ content: [{ type: 'audio', data: TINY_WAV_BASE64, mimeType: 'audio/wav' }] }),
    },
    {
      // tools-call-embedded-resource: one embedded resource content block.
      name: 'test_embedded_resource',
      description: 'Conformance fixture: returns an embedded resource content block.',
      inputSchema: { ...NO_ARGS_SCHEMA },
      call: async () => ({
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'test://embedded-resource',
              mimeType: 'text/plain',
              text: 'Embedded resource content for testing.',
            },
          },
        ],
      }),
    },
    {
      // tools-call-mixed-content: several content types in one result.
      name: 'test_multiple_content_types',
      description: 'Conformance fixture: returns text and image content together.',
      inputSchema: { ...NO_ARGS_SCHEMA },
      call: async () => ({
        content: [
          { type: 'text', text: 'Multiple content types test:' },
          { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' },
          {
            type: 'resource',
            resource: { uri: 'test://mixed-content-resource', mimeType: 'text/plain', text: 'Mixed content resource.' },
          },
        ],
      }),
    },
    {
      // tools-call-with-progress: three progress notifications when the
      // request carries a progressToken, then a text result. On the stateless
      // path the notifications ride the response stream (see
      // `stateless-handler.ts`).
      name: 'test_tool_with_progress',
      description: 'Conformance fixture: reports progress 0/50/100 when a progressToken is provided.',
      inputSchema: { ...NO_ARGS_SCHEMA },
      call: async (_args, ctx) => {
        const progressToken = ctx.meta['progressToken'];
        if (progressToken !== undefined) {
          for (const progress of [0, 50, 100]) {
            ctx.notify('notifications/progress', { progressToken, progress, total: 100 });
          }
        }
        return textResult('Progress tool completed.');
      },
    },
    {
      // json-schema-2020-12 (SEP-1613/SEP-2106): the inputSchema must reach
      // tools/list byte-preserved — `$schema`, `$defs`/`$anchor`, composition
      // and conditional keywords intact.
      name: 'json_schema_2020_12_tool',
      description: 'Tool with JSON Schema 2020-12 features',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        $defs: {
          address: {
            $anchor: 'addressDef',
            type: 'object',
            properties: { street: { type: 'string' }, city: { type: 'string' } },
          },
        },
        properties: {
          name: { type: 'string' },
          address: { $ref: '#/$defs/address' },
          contactMethod: { type: 'string', enum: ['phone', 'email'] },
          phone: { type: 'string' },
          email: { type: 'string' },
        },
        allOf: [{ anyOf: [{ required: ['phone'] }, { required: ['email'] }] }],
        if: { properties: { contactMethod: { const: 'phone' } }, required: ['contactMethod'] },
        then: { required: ['phone'] },
        else: { required: ['email'] },
        additionalProperties: false,
      },
      call: async () => textResult('JSON Schema 2020-12 fixture executed.'),
    },
    {
      // http-custom-header-server-validation (SEP-2243): one tool with an
      // `x-mcp-header` annotated string parameter. The HANDLER owns all of
      // the header/body matching and Base64 validation; by the time this
      // runs, the value has been validated.
      name: 'test_custom_headers',
      description: 'Conformance fixture: echoes a parameter that rides in the Mcp-Param-custom-data header.',
      inputSchema: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'Value mirrored in Mcp-Param-custom-data.', 'x-mcp-header': 'custom-data' },
        },
        required: ['data'],
      },
      call: async (args) => textResult(`custom-data=${String(args['data'] ?? '')}`),
    },
  ];
}

export interface ConformanceFixturePrompt {
  definition: { name: string; description: string; arguments?: Array<{ name: string; required?: boolean }> };
  get: (args: Record<string, string>) => Record<string, unknown>;
}

export function buildConformanceFixturePrompts(): ConformanceFixturePrompt[] {
  return [
    {
      // prompts-get-simple: at least one message with role + content.
      definition: { name: 'test_simple_prompt', description: 'Conformance fixture: a one-message prompt.' },
      get: () => ({
        description: 'Conformance fixture prompt.',
        messages: [{ role: 'user', content: { type: 'text', text: 'This is the conformance fixture prompt.' } }],
      }),
    },
    {
      // prompts-get-with-args: both arguments must appear in the rendered
      // messages.
      definition: {
        name: 'test_prompt_with_arguments',
        description: 'Conformance fixture: substitutes arg1 and arg2 into the message.',
        arguments: [
          { name: 'arg1', required: true },
          { name: 'arg2', required: true },
        ],
      },
      get: (args) => ({
        description: 'Conformance fixture prompt with arguments.',
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: `arg1=${args['arg1'] ?? ''} arg2=${args['arg2'] ?? ''}` },
          },
        ],
      }),
    },
    {
      // prompts-get-embedded-resource: embeds the resourceUri argument.
      definition: {
        name: 'test_prompt_with_embedded_resource',
        description: 'Conformance fixture: embeds the resource named by resourceUri.',
        arguments: [{ name: 'resourceUri', required: true }],
      },
      get: (args) => ({
        description: 'Conformance fixture prompt with an embedded resource.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'resource',
              resource: {
                uri: args['resourceUri'] ?? '',
                mimeType: 'text/plain',
                text: 'Embedded resource content for testing.',
              },
            },
          },
          { role: 'user', content: { type: 'text', text: 'Please use the resource above.' } },
        ],
      }),
    },
    {
      // prompts-get-with-image: an image message then a text message.
      definition: {
        name: 'test_prompt_with_image',
        description: 'Conformance fixture: a prompt carrying an image content block.',
      },
      get: () => ({
        description: 'Conformance fixture prompt with an image.',
        messages: [
          { role: 'user', content: { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' } },
          { role: 'user', content: { type: 'text', text: 'Please analyse the image above.' } },
        ],
      }),
    },
  ];
}

/** Fixture resources for the resources-read scenarios: two static resources
 * and one template, exactly as each scenario's requirements section names
 * them. */
export function buildConformanceFixtureResources(): NonNullable<StatelessSurface['resources']> {
  const templatePattern = /^test:\/\/template\/([^/]+)\/data$/;
  return {
    list: () => [
      { uri: 'test://static-text', name: 'Static text resource', mimeType: 'text/plain' },
      { uri: 'test://static-binary', name: 'Static binary resource', mimeType: 'image/png' },
    ],
    templates: () => [
      {
        uriTemplate: 'test://template/{id}/data',
        name: 'Template resource',
        mimeType: 'application/json',
      },
    ],
    read: (uri) => {
      if (uri === 'test://static-text') {
        return {
          contents: [
            { uri, mimeType: 'text/plain', text: 'This is the content of the static text resource.' },
          ],
        };
      }
      if (uri === 'test://static-binary') {
        return { contents: [{ uri, mimeType: 'image/png', blob: TINY_PNG_BASE64 }] };
      }
      const match = templatePattern.exec(uri);
      if (match) {
        const idValue = match[1] as string;
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ id: idValue, templateTest: true, data: `Data for ID: ${idValue}` }),
            },
          ],
        };
      }
      return null;
    },
  };
}

/** Fixture completion provider (`completion/complete`): prefix-filtered
 * suggestions for the fixture prompt's arguments. */
export function buildConformanceFixtureCompletion(): NonNullable<StatelessSurface['complete']> {
  const SUGGESTIONS = ['paris', 'park', 'party', 'python', 'prague'];
  return (_ref, argument) => {
    const values = SUGGESTIONS.filter((v) => v.startsWith(argument.value.toLowerCase()));
    return { values, total: values.length, hasMore: false };
  };
}
