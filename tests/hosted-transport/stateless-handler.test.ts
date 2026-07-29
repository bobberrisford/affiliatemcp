/**
 * Unit tests for the MCP 2026-07-28 stateless protocol handler
 * (`src/hosted-transport/stateless-handler.ts`). The official conformance
 * suite is the external oracle (`npm run conformance:hosted`); these tests
 * pin the same wire behaviours in-process so a regression fails fast in
 * `npm test` without booting the harness.
 */

import { describe, expect, it } from 'vitest';

import {
  handleStatelessRequest,
  isStatelessRequest,
  STATELESS_PROTOCOL_VERSION,
  type StatelessSurface,
} from '../../src/hosted-transport/stateless-handler.js';

const META = {
  'io.modelcontextprotocol/protocolVersion': STATELESS_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

function surface(overrides?: Partial<StatelessSurface>): StatelessSurface {
  return {
    serverInfo: { name: 'test-server', version: '0.0.0' },
    tools: [
      {
        name: 'echo_tool',
        description: 'Echoes.',
        inputSchema: { type: 'object', properties: {} },
        call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      },
      {
        name: 'needs_sampling',
        description: 'Requires the sampling client capability.',
        inputSchema: { type: 'object', properties: {} },
        requiredClientCapabilities: ['sampling'],
        call: async () => ({ content: [{ type: 'text', text: 'sampled' }] }),
      },
      {
        name: 'header_tool',
        description: 'Carries an x-mcp-header parameter.',
        inputSchema: {
          type: 'object',
          properties: { data: { type: 'string', 'x-mcp-header': 'custom-data' } },
          required: ['data'],
        },
        call: async (args) => ({ content: [{ type: 'text', text: String(args['data']) }] }),
      },
    ],
    prompts: { list: () => [], get: () => ({ messages: [] }) },
    ...overrides,
  };
}

function headers(extra?: Record<string, string>): Record<string, string | undefined> {
  return {
    'mcp-protocol-version': STATELESS_PROTOCOL_VERSION,
    'mcp-method': 'server/discover',
    ...extra,
  };
}

function request(method: string, params?: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id: 7, method, params: { _meta: META, ...params } };
}

describe('isStatelessRequest', () => {
  it('routes on the Mcp-Method header', () => {
    expect(isStatelessRequest({ 'mcp-method': 'tools/list' })).toBe(true);
  });

  it('routes on the 2026-07-28 protocol version header even without Mcp-Method', () => {
    expect(isStatelessRequest({ 'mcp-protocol-version': STATELESS_PROTOCOL_VERSION })).toBe(true);
  });

  it('leaves legacy requests alone', () => {
    expect(isStatelessRequest({})).toBe(false);
    expect(isStatelessRequest({ 'mcp-protocol-version': '2025-06-18' })).toBe(false);
  });
});

describe('handleStatelessRequest gates', () => {
  it('rejects a missing MCP-Protocol-Version header with -32020 and HTTP 400', async () => {
    const res = await handleStatelessRequest(surface(), { 'mcp-method': 'server/discover' }, request('server/discover'));
    expect(res.status).toBe(400);
    expect((res.body['error'] as { code: number }).code).toBe(-32020);
  });

  it('rejects missing required _meta keys with -32602, naming them', async () => {
    const res = await handleStatelessRequest(surface(), headers(), {
      jsonrpc: '2.0',
      id: 7,
      method: 'server/discover',
      params: {},
    });
    expect(res.status).toBe(400);
    const error = res.body['error'] as { code: number; message: string };
    expect(error.code).toBe(-32602);
    expect(error.message).toContain('io.modelcontextprotocol/protocolVersion');
  });

  it('rejects a header/_meta version mismatch with -32020', async () => {
    const res = await handleStatelessRequest(surface(), headers({ 'mcp-protocol-version': '2099-01-01' }), request('server/discover'));
    expect(res.status).toBe(400);
    expect((res.body['error'] as { code: number }).code).toBe(-32020);
  });

  it('rejects an agreed-but-unsupported version with -32022 carrying supported/requested', async () => {
    const badMeta = { ...META, 'io.modelcontextprotocol/protocolVersion': 'v999.0.0' };
    const res = await handleStatelessRequest(
      surface(),
      headers({ 'mcp-protocol-version': 'v999.0.0' }),
      { jsonrpc: '2.0', id: 7, method: 'server/discover', params: { _meta: badMeta } },
    );
    expect(res.status).toBe(400);
    const error = res.body['error'] as { code: number; data: { supported: string[]; requested: string } };
    expect(error.code).toBe(-32022);
    expect(error.data.supported).toEqual([STATELESS_PROTOCOL_VERSION]);
    expect(error.data.requested).toBe('v999.0.0');
  });

  it('rejects an Mcp-Method/body mismatch with -32020 and preserves the id', async () => {
    const res = await handleStatelessRequest(surface(), headers({ 'mcp-method': 'prompts/list' }), request('tools/list'));
    expect(res.status).toBe(400);
    expect(res.body['id']).toBe(7);
    expect((res.body['error'] as { code: number }).code).toBe(-32020);
  });

  it('trims optional whitespace around header values before comparing', async () => {
    const res = await handleStatelessRequest(
      surface(),
      headers({ 'mcp-method': '  tools/call  ', 'mcp-name': '  echo_tool  ' }),
      request('tools/call', { name: 'echo_tool', arguments: {} }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects a missing Mcp-Name header when the body names a tool', async () => {
    const res = await handleStatelessRequest(
      surface(),
      headers({ 'mcp-method': 'tools/call' }),
      request('tools/call', { name: 'echo_tool', arguments: {} }),
    );
    expect(res.status).toBe(400);
    expect((res.body['error'] as { code: number }).code).toBe(-32020);
  });

  it('rejects a disallowed Origin with HTTP 403', async () => {
    const res = await handleStatelessRequest(surface(), headers({ origin: 'http://evil.example' }), request('server/discover'));
    expect(res.status).toBe(403);
  });

  it('accepts localhost and explicitly allowed Origins', async () => {
    const local = await handleStatelessRequest(surface(), headers({ origin: 'http://127.0.0.1:8787' }), request('server/discover'));
    expect(local.status).toBe(200);
    const allowed = await handleStatelessRequest(
      surface(),
      headers({ origin: 'https://mcp.example.co' }),
      request('server/discover'),
      { allowedOriginHosts: ['mcp.example.co'] },
    );
    expect(allowed.status).toBe(200);
  });
});

describe('handleStatelessRequest routing and results', () => {
  it('serves server/discover with supportedVersions, capabilities, serverInfo, and caching hints', async () => {
    const res = await handleStatelessRequest(surface(), headers(), request('server/discover'));
    expect(res.status).toBe(200);
    const result = res.body['result'] as Record<string, unknown>;
    expect(result['supportedVersions']).toEqual([STATELESS_PROTOCOL_VERSION]);
    expect(result['capabilities']).toMatchObject({ tools: {}, prompts: {} });
    expect((result['_meta'] as Record<string, unknown>)['io.modelcontextprotocol/serverInfo']).toMatchObject({
      name: 'test-server',
    });
    expect(result['resultType']).toBe('complete');
    expect(result['ttlMs']).toBe(0);
    expect(result['cacheScope']).toBe('private');
  });

  it('maps removed lifecycle methods and unknown methods to HTTP 404 with -32601', async () => {
    for (const method of ['initialize', 'ping', 'logging/setLevel', 'unknown/method']) {
      const res = await handleStatelessRequest(surface(), headers({ 'mcp-method': method }), request(method));
      expect(res.status).toBe(404);
      expect(res.body['id']).toBe(7);
      expect((res.body['error'] as { code: number }).code).toBe(-32601);
    }
  });

  it('refuses a tool needing an undeclared client capability with -32021 and a capabilities OBJECT', async () => {
    const res = await handleStatelessRequest(
      surface(),
      headers({ 'mcp-method': 'tools/call', 'mcp-name': 'needs_sampling' }),
      request('tools/call', { name: 'needs_sampling', arguments: {} }),
    );
    expect(res.status).toBe(400);
    const error = res.body['error'] as { code: number; data: { requiredCapabilities: unknown } };
    expect(error.code).toBe(-32021);
    expect(error.data.requiredCapabilities).toEqual({ sampling: {} });
  });

  it('runs the tool when the capability is declared', async () => {
    const meta = { ...META, 'io.modelcontextprotocol/clientCapabilities': { sampling: {} } };
    const res = await handleStatelessRequest(
      surface(),
      headers({ 'mcp-method': 'tools/call', 'mcp-name': 'needs_sampling' }),
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { _meta: meta, name: 'needs_sampling', arguments: {} } },
    );
    expect(res.status).toBe(200);
  });

  it('does not add caching hints to tools/call results', async () => {
    const res = await handleStatelessRequest(
      surface(),
      headers({ 'mcp-method': 'tools/call', 'mcp-name': 'echo_tool' }),
      request('tools/call', { name: 'echo_tool', arguments: {} }),
    );
    const result = res.body['result'] as Record<string, unknown>;
    expect(result['resultType']).toBe('complete');
    expect(result['ttlMs']).toBeUndefined();
    expect(result['cacheScope']).toBeUndefined();
  });

  it('validates Mcp-Param headers: base64 decode, invalid padding, literal, and body-only rejection', async () => {
    const call = (headerValue: string | undefined, bodyValue: string) =>
      handleStatelessRequest(
        surface(),
        headers({
          'mcp-method': 'tools/call',
          'mcp-name': 'header_tool',
          ...(headerValue !== undefined ? { 'mcp-param-custom-data': headerValue } : {}),
        }),
        request('tools/call', { name: 'header_tool', arguments: { data: bodyValue } }),
      );

    const valid = await call('=?base64?SGVsbG8=?=', 'Hello');
    expect(valid.status).toBe(200);

    const badPadding = await call('=?base64?SGVsbG8?=', 'Hello');
    expect(badPadding.status).toBe(400);
    expect((badPadding.body['error'] as { code: number }).code).toBe(-32020);

    const literal = await call('plain-value', 'plain-value');
    expect(literal.status).toBe(200);

    const missingHeader = await call(undefined, 'body-only');
    expect(missingHeader.status).toBe(400);
    expect((missingHeader.body['error'] as { code: number }).code).toBe(-32020);
  });

  it('answers resources/read for an unknown URI with -32602 naming the URI (SEP-2164)', async () => {
    const res = await handleStatelessRequest(
      surface(),
      headers({ 'mcp-method': 'resources/read', 'mcp-name': 'test://missing' }),
      request('resources/read', { uri: 'test://missing' }),
    );
    expect(res.status).toBe(400);
    const error = res.body['error'] as { code: number; data: { uri: string } };
    expect(error.code).toBe(-32602);
    expect(error.data.uri).toBe('test://missing');
  });

  it('queues progress notifications onto the response, before the final frame', async () => {
    const withProgress = surface({
      tools: [
        {
          name: 'progress_tool',
          description: 'Reports progress.',
          inputSchema: { type: 'object', properties: {} },
          call: async (_args, ctx) => {
            ctx.notify('notifications/progress', { progressToken: ctx.meta['progressToken'], progress: 100, total: 100 });
            return { content: [{ type: 'text', text: 'done' }] };
          },
        },
      ],
    });
    const meta = { ...META, progressToken: 'tok-1' };
    const res = await handleStatelessRequest(
      withProgress,
      headers({ 'mcp-method': 'tools/call', 'mcp-name': 'progress_tool' }),
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { _meta: meta, name: 'progress_tool', arguments: {} } },
    );
    expect(res.status).toBe(200);
    expect(res.notifications).toHaveLength(1);
    expect((res.notifications?.[0] as { method: string }).method).toBe('notifications/progress');
  });
});
