import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { detectClients } from '../../../src/cli/install/detect.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-detect-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('detectClients', () => {
  it('reports linux desktop as notSupported', async () => {
    const result = await detectClients({
      platform: 'linux',
      env: {},
      probeClaudeCode: async () => false,
      probeDesktopBundle: () => false,
    });
    expect(result.desktop).toBe('notSupported');
    expect(result.desktopConfigPath).toBeNull();
  });

  it('reports macOS desktop as present when the config file exists', async () => {
    // Force the config path to a tmp file that exists by stubbing HOME.
    const originalHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    try {
      const configDir = path.join(tmp, 'Library', 'Application Support', 'Claude');
      const configPath = path.join(configDir, 'claude_desktop_config.json');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, '{}');
      const result = await detectClients({
        platform: 'darwin',
        env: {},
        probeClaudeCode: async () => false,
        probeDesktopBundle: () => false,
      });
      expect(result.desktop).toBe('present');
      expect(result.desktopConfigPath).toBe(configPath);
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });

  it('reports macOS desktop as present when the app bundle exists but config does not', async () => {
    const originalHome = process.env['HOME'];
    process.env['HOME'] = tmp; // no config file
    try {
      const result = await detectClients({
        platform: 'darwin',
        env: {},
        probeClaudeCode: async () => false,
        probeDesktopBundle: () => true,
      });
      expect(result.desktop).toBe('present');
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });

  it('reports macOS desktop as absent when neither config nor bundle exist', async () => {
    const originalHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    try {
      const result = await detectClients({
        platform: 'darwin',
        env: {},
        probeClaudeCode: async () => false,
        probeDesktopBundle: () => false,
      });
      expect(result.desktop).toBe('absent');
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });

  it('reports win32 desktop notSupported when APPDATA is missing', async () => {
    const result = await detectClients({
      platform: 'win32',
      env: {},
      probeClaudeCode: async () => false,
      probeDesktopBundle: () => false,
    });
    expect(result.desktop).toBe('notSupported');
    expect(result.desktopConfigPath).toBeNull();
  });

  it('reports claude code present when the probe succeeds', async () => {
    const result = await detectClients({
      platform: 'linux',
      env: {},
      probeClaudeCode: async () => true,
      probeDesktopBundle: () => false,
    });
    expect(result.code).toBe('present');
  });

  it('reports claude code absent when the probe fails', async () => {
    const result = await detectClients({
      platform: 'linux',
      env: {},
      probeClaudeCode: async () => false,
      probeDesktopBundle: () => false,
    });
    expect(result.code).toBe('absent');
  });
});
