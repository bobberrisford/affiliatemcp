import { describe, expect, it } from 'vitest';
import { parseEnvFile } from '../../src/shared/config.js';

describe('config parser', () => {
  it('parses KEY=value pairs', () => {
    const out = parseEnvFile('FOO=bar\nBAZ=qux');
    expect(out).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comments and blank lines', () => {
    const out = parseEnvFile('# a comment\n\nFOO=bar\n# trailing');
    expect(out).toEqual({ FOO: 'bar' });
  });

  it('strips matched single and double quotes', () => {
    const out = parseEnvFile(`A="hello"\nB='world'\nC=plain`);
    expect(out).toEqual({ A: 'hello', B: 'world', C: 'plain' });
  });
});
