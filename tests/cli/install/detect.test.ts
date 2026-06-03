import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      env: { HOME: tmp },
      probeClaudeCode: async () => false,
      probeDesktopBundle: () => false,
      probeCodex: async () => false,
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
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, '{}');
      const result = await detectClients({
        platform: 'darwin',
        env: { HOME: tmp },
        probeClaudeCode: async () => false,
        probeDesktopBundle: () => false,
        probeCodex: async () => false,
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
        env: { HOME: tmp },
        probeClaudeCode: async () => false,
        probeDesktopBundle: () => true,
        probeCodex: async () => false,
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
        env: { HOME: tmp },
        probeClaudeCode: async () => false,
        probeDesktopBundle: () => false,
        probeCodex: async () => false,
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
      env: { HOME: tmp },
      probeClaudeCode: async () => false,
      probeDesktopBundle: () => false,
      probeCodex: async () => false,
    });
    expect(result.desktop).toBe('notSupported');
    expect(result.desktopConfigPath).toBeNull();
  });

  it('reports claude code present when the probe succeeds', async () => {
    const result = await detectClients({
      platform: 'linux',
      env: { HOME: tmp },
      probeClaudeCode: async () => true,
      probeDesktopBundle: () => false,
      probeCodex: async () => false,
    });
    expect(result.code).toBe('present');
  });

  it('reports claude code absent when the probe fails', async () => {
    const result = await detectClients({
      platform: 'linux',
      env: { HOME: tmp },
      probeClaudeCode: async () => false,
      probeDesktopBundle: () => false,
      probeCodex: async () => false,
    });
    expect(result.code).toBe('absent');
  });

  it('reports codex present when the probe succeeds', async () => {
    const result = await detectClients({
      platform: 'linux',
      env: { HOME: tmp },
      probeClaudeCode: async () => false,
      probeDesktopBundle: () => false,
      probeCodex: async () => true,
    });
    expect(result.codex).toBe('present');
  });

  it('reports codex present when the config directory exists', async () => {
    mkdirSync(path.join(tmp, '.codex'), { recursive: true });
    const result = await detectClients({
      platform: 'linux',
      env: { HOME: tmp },
      probeClaudeCode: async () => false,
      probeDesktopBundle: () => false,
    });
    expect(result.codex).toBe('present');
  });

  it('reports codex absent when the probe fails and no config directory exists', async () => {
    const result = await detectClients({
      platform: 'linux',
      env: { HOME: tmp },
      probeClaudeCode: async () => false,
      probeDesktopBundle: () => false,
      probeCodex: async () => false,
    });
    expect(result.codex).toBe('absent');
  });
});
