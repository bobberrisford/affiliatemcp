#!/usr/bin/env tsx
/**
 * Diff-aware collaboration guardrails.
 *
 * This checks only the current change, so existing debt does not block shipping.
 * Hard failures protect established architecture rules; warnings identify work
 * that deserves a closer review rather than automatically rejecting it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

export interface ChangedLine {
  path: string;
  line: string;
}

export interface ChangeInput {
  changedFiles: string[];
  addedLines: ChangedLine[];
  additions: number;
}

export interface ChangeFinding {
  level: 'error' | 'warning';
  message: string;
}

const NETWORK_SOURCE_RE = /^src\/networks\/([^/]+)\/.+\.ts$/;
const NETWORK_TEST_RE = /^tests\/networks\/([^/]+)\//;

export function analyseChange(input: ChangeInput): ChangeFinding[] {
  const findings: ChangeFinding[] = [];
  const changed = new Set(input.changedFiles);

  for (const { path, line } of input.addedLines) {
    if (path.startsWith('src/') && /\bconsole\.log\s*\(/.test(line)) {
      findings.push({
        level: 'error',
        message: `${path}: new console.log; use the project logger`,
      });
    }
    if (path.startsWith('src/') && /@ts-ignore\b/.test(line)) {
      findings.push({ level: 'error', message: `${path}: new @ts-ignore is not allowed` });
    }
    if (path.startsWith('src/') && /\bas any\b/.test(line)) {
      findings.push({
        level: 'error',
        message: `${path}: new "as any" bypasses the shared type contract`,
      });
    }

    const networkMatch = path.match(NETWORK_SOURCE_RE);
    if (!networkMatch) continue;

    if (!path.endsWith('/client.ts') && !path.endsWith('/auth.ts') && /\bfetch\s*\(/.test(line)) {
      findings.push({
        level: 'error',
        message: `${path}: direct fetch belongs in the network client or auth module`,
      });
    }

    const relativeImport = line.match(/(?:from\s+|import\s*\(\s*)['"](\.\.\/[^'"]+)['"]/);
    const relativeSpecifier = relativeImport?.[1];
    const importedNetwork = relativeSpecifier
      ? posix
          .normalize(posix.join(posix.dirname(path), relativeSpecifier))
          .match(/^src\/networks\/([^/]+)(?:\/|$)/)?.[1]
      : undefined;
    if (importedNetwork && importedNetwork !== networkMatch[1]) {
      findings.push({
        level: 'error',
        message: `${path}: network adapters must not import another network adapter`,
      });
    }
  }

  const changedNetworkTests = new Set(
    input.changedFiles.flatMap((path) => {
      const match = path.match(NETWORK_TEST_RE);
      return match?.[1] ? [match[1]] : [];
    }),
  );
  const changedNetworkSources = new Set(
    input.changedFiles.flatMap((path) => {
      const match = path.match(NETWORK_SOURCE_RE);
      return match?.[1] ? [match[1]] : [];
    }),
  );
  for (const slug of changedNetworkSources) {
    if (!changedNetworkTests.has(slug)) {
      findings.push({
        level: 'error',
        message: `src/networks/${slug}/ changed without a matching tests/networks/${slug}/ change`,
      });
    }
  }

  if (
    input.changedFiles.some((path) => path.startsWith('src/shared/')) &&
    !input.changedFiles.some(
      (path) => path.startsWith('tests/shared/') || path.startsWith('tests/integration/'),
    )
  ) {
    findings.push({
      level: 'error',
      message: 'src/shared/ changed without a matching shared or integration test change',
    });
  }

  if (input.changedFiles.length > 20 || input.additions > 1000) {
    findings.push({
      level: 'warning',
      message: `large change (${input.changedFiles.length} files, ${input.additions} additions); explain why it should not be split`,
    });
  }
  if (changedNetworkSources.size > 1) {
    findings.push({
      level: 'warning',
      message: `change touches ${changedNetworkSources.size} network adapters; confirm one coherent outcome`,
    });
  }
  if (input.changedFiles.some((path) => path.startsWith('src/shared/'))) {
    findings.push({
      level: 'warning',
      message: 'shared contract or behaviour changed; request risk-based review',
    });
  }
  if (
    changed.has('package.json') ||
    changed.has('package-lock.json') ||
    input.changedFiles.some((path) => path.startsWith('.github/workflows/'))
  ) {
    findings.push({
      level: 'warning',
      message: 'dependency or CI configuration changed; include focused reviewer context',
    });
  }

  return deduplicate(findings);
}

export function parseAddedLines(diff: string): ChangedLine[] {
  const lines: ChangedLine[] = [];
  let currentPath: string | undefined;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice('+++ b/'.length);
      continue;
    }
    if (currentPath && line.startsWith('+') && !line.startsWith('+++')) {
      lines.push({ path: currentPath, line: line.slice(1) });
    }
  }
  return lines;
}

function deduplicate(findings: ChangeFinding[]): ChangeFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.level}:${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runCli(): number {
  const base = argumentValue('--base') ?? 'origin/main';
  const committedRange = `${base}...HEAD`;
  const committedFiles = git(['diff', '--name-only', committedRange]).split('\n').filter(Boolean);
  const workingFiles = git(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  const untrackedFiles = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean);
  const changedFiles = [...new Set([...committedFiles, ...workingFiles, ...untrackedFiles])].sort();

  const committedDiff = git(['diff', '--unified=0', '--no-ext-diff', committedRange]);
  const workingDiff = git(['diff', '--unified=0', '--no-ext-diff', 'HEAD']);
  const untrackedLines = untrackedFiles.flatMap((path) => {
    try {
      return readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => ({ path, line }));
    } catch {
      return [];
    }
  });
  const addedLines = [...parseAddedLines(`${committedDiff}\n${workingDiff}`), ...untrackedLines];
  const additions = addedLines.length;
  const findings = analyseChange({ changedFiles, addedLines, additions });

  process.stderr.write(
    `change guardrails: ${changedFiles.length} changed files, ${additions} added lines against ${base}\n`,
  );
  for (const finding of findings) {
    process.stderr.write(`${finding.level === 'error' ? 'ERROR' : 'WARN '} ${finding.message}\n`);
  }

  const errorCount = findings.filter((finding) => finding.level === 'error').length;
  if (errorCount > 0) {
    process.stderr.write(`change guardrails failed with ${errorCount} error(s)\n`);
    return 1;
  }
  process.stderr.write('change guardrails passed\n');
  return 0;
}

if (process.argv[1]?.endsWith('check-change.ts')) {
  try {
    process.exit(runCli());
  } catch (err) {
    process.stderr.write(`check-change fatal: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
