import { describe, expect, it } from 'vitest';

import { buildManifest, MCPB_SETUP_NETWORKS } from '../../scripts/build-mcpb.js';
import { setupSteps } from '../../src/core/facade.js';

describe('MCPB distribution manifest', () => {
  const manifest = buildManifest({
    version: '1.2.3',
    description: 'test package',
  });

  it('runs the bundled server directly through the host Node runtime', () => {
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.server).toMatchObject({
      type: 'node',
      entry_point: 'server/index.cjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.cjs'],
      },
    });
  });

  it('maps every launch-network setup field into host-managed environment config', () => {
    for (const network of MCPB_SETUP_NETWORKS) {
      for (const step of setupSteps(network)) {
        const key = step.field.toLowerCase();
        expect(manifest.user_config[key]).toMatchObject({
          sensitive: step.type === 'password',
          required: false,
        });
        expect(manifest.server.mcp_config.env[step.field]).toBe(`\${user_config.${key}}`);
      }
    }
  });

  it('does not promise CLI-only automatic derivation in the native settings form', () => {
    expect(manifest.user_config.awin_publisher_id?.title).not.toMatch(/auto-derived/i);
    expect(manifest.user_config.awin_publisher_id?.description).toMatch(
      /cannot auto-derive this value/i,
    );
  });

  it('allows an existing local config directory to supply all other adapters', () => {
    expect(manifest.user_config.existing_config_directory).toMatchObject({
      type: 'directory',
      required: false,
    });
    expect(manifest.server.mcp_config.env.AFFILIATE_MCP_CONFIG_DIR).toBe(
      '${user_config.existing_config_directory}',
    );
  });
});
