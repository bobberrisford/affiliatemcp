import { describe, expect, it } from 'vitest';

import { analyseChange, parseAddedLines } from '../../scripts/check-change.js';

describe('check-change guardrails', () => {
  it('rejects architecture bypasses introduced by the change', () => {
    const findings = analyseChange({
      changedFiles: ['src/networks/example/adapter.ts', 'tests/networks/example/adapter.test.ts'],
      additions: 4,
      addedLines: [
        { path: 'src/networks/example/adapter.ts', line: 'console.log("debug");' },
        { path: 'src/networks/example/adapter.ts', line: 'const response = await fetch(url);' },
        {
          path: 'src/networks/example/adapter.ts',
          line: "import { helper } from '../other/adapter.js';",
        },
        { path: 'src/networks/example/adapter.ts', line: 'return value as any;' },
      ],
    });

    expect(findings.filter((finding) => finding.level === 'error')).toHaveLength(4);
  });

  it('requires a matching adapter test change', () => {
    const findings = analyseChange({
      changedFiles: ['src/networks/example/adapter.ts'],
      additions: 1,
      addedLines: [{ path: 'src/networks/example/adapter.ts', line: 'return programmes;' }],
    });

    expect(findings).toContainEqual({
      level: 'error',
      message: 'src/networks/example/ changed without a matching tests/networks/example/ change',
    });
  });

  it('requires shared changes to include shared or integration tests', () => {
    const findings = analyseChange({
      changedFiles: ['src/shared/types.ts'],
      additions: 1,
      addedLines: [{ path: 'src/shared/types.ts', line: 'export type NewContract = string;' }],
    });

    expect(findings.some((finding) => finding.level === 'error')).toBe(true);
    expect(findings).toContainEqual({
      level: 'warning',
      message: 'shared contract or behaviour changed; request risk-based review',
    });
  });

  it('warns rather than failing on review scope signals', () => {
    const changedFiles = Array.from({ length: 21 }, (_, index) => `docs/file-${index}.md`);
    const findings = analyseChange({ changedFiles, additions: 1001, addedLines: [] });

    expect(findings).toEqual([
      {
        level: 'warning',
        message: 'large change (21 files, 1001 additions); explain why it should not be split',
      },
    ]);
  });
});

describe('parseAddedLines', () => {
  it('keeps added content associated with its changed path', () => {
    const lines = parseAddedLines(
      [
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1 +1,2 @@',
        ' unchanged',
        '+added();',
      ].join('\n'),
    );

    expect(lines).toEqual([{ path: 'src/example.ts', line: 'added();' }]);
  });
});
