import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { atomicWriteJSON, timestampedBackup } from '../../../src/cli/install/atomic-write.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-aw-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('atomicWriteJSON', () => {
  it('writes JSON with 2-space indent and trailing newline', () => {
    const target = path.join(tmp, 'config.json');
    atomicWriteJSON(target, { a: 1, b: { c: 'two' } });
    const body = readFileSync(target, 'utf8');
    expect(body).toBe('{\n  "a": 1,\n  "b": {\n    "c": "two"\n  }\n}\n');
  });

  it('replaces an existing file in place', () => {
    const target = path.join(tmp, 'config.json');
    writeFileSync(target, '{"old": true}\n');
    atomicWriteJSON(target, { fresh: true });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ fresh: true });
  });

  it('leaves no stray .tmp files behind on success', () => {
    const target = path.join(tmp, 'config.json');
    atomicWriteJSON(target, { ok: true });
    const stray = readdirSync(tmp).filter((f) => f.includes('.tmp.'));
    expect(stray).toEqual([]);
  });
});

describe('timestampedBackup', () => {
  it('copies the file to a .bak.<stamp> sibling and returns the path', () => {
    const target = path.join(tmp, 'config.json');
    writeFileSync(target, '{"original": true}\n');
    const fixedDate = new Date(2026, 4, 28, 11, 45, 23);
    const backupPath = timestampedBackup(target, fixedDate);
    expect(backupPath).toBe(path.join(tmp, 'config.json.bak.20260528-114523'));
    expect(readFileSync(backupPath, 'utf8')).toBe('{"original": true}\n');
    // Original is unchanged.
    expect(readFileSync(target, 'utf8')).toBe('{"original": true}\n');
  });

  it('throws if the source does not exist', () => {
    const target = path.join(tmp, 'missing.json');
    expect(() => timestampedBackup(target)).toThrow(/does not exist/);
  });
});
