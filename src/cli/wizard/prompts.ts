/**
 * Prompt abstraction for the setup wizard.
 *
 * We chose a deps-free approach using `node:readline/promises`. The rationale:
 *   - Adding a dependency (enquirer / prompts) for a single user-facing surface
 *     would pull in transitive code we don't otherwise need.
 *   - Node ships `readline/promises` (since v17) which gives us masked password
 *     input via the underlying readline `_writeToOutput` hook and ordinary
 *     line-based input for text/number/menu choices.
 *   - The wizard's prompt surface is small (text, password, number, menu,
 *     confirm, multi-select). A 100-line wrapper covers it.
 *
 * Future contributors: if the UX needs cursor-driven multi-select or in-place
 * editing, swap this module's implementation for `prompts` or `enquirer`. The
 * `Prompter` interface below is the public contract — keep that stable so the
 * wizard handlers don't need to change.
 *
 * Tests inject a fake `Prompter` via `setPrompter()`; we do not test the
 * readline-backed default. The default is exercised only by manual runs of
 * the wizard.
 */

import * as readline from 'node:readline/promises';
import { Writable } from 'node:stream';

export interface Prompter {
  /** Prompt for plain text. Returns trimmed input. */
  text(label: string, opts?: { example?: string; defaultValue?: string }): Promise<string>;
  /** Prompt for a password (input masked). Returns the raw value (no trim). */
  password(label: string): Promise<string>;
  /** Prompt for a number. Returns the parsed value; re-prompts on invalid. */
  number(label: string, opts?: { example?: string }): Promise<number>;
  /** Single-choice menu. Returns the selected key. */
  menu<K extends string>(label: string, choices: Array<{ key: K; label: string }>): Promise<K>;
  /** Multi-select. Returns the selected keys (in input order). */
  selectMany<K extends string>(
    label: string,
    choices: Array<{ key: K; label: string }>,
  ): Promise<K[]>;
  /** Yes/no confirmation. Defaults to false unless `defaultYes` is set. */
  confirm(label: string, opts?: { defaultYes?: boolean }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Readline-backed default
// ---------------------------------------------------------------------------

/**
 * Wraps stdout so we can suppress echo for password input. readline's
 * `_writeToOutput` hook lets us swap the destination per-prompt without
 * rebuilding the interface.
 */
class MutableOutput extends Writable {
  public muted = false;
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    if (!this.muted) {
      process.stdout.write(chunk);
    } else if (typeof chunk === 'string' && (chunk === '\n' || chunk === '\r\n')) {
      process.stdout.write(chunk);
    }
    cb();
  }
}

class ReadlinePrompter implements Prompter {
  private async withInterface<T>(
    fn: (rl: readline.Interface, mut: MutableOutput) => Promise<T>,
  ): Promise<T> {
    const mut = new MutableOutput();
    const rl = readline.createInterface({ input: process.stdin, output: mut, terminal: true });
    try {
      return await fn(rl, mut);
    } finally {
      rl.close();
    }
  }

  async text(
    label: string,
    opts?: { example?: string; defaultValue?: string },
  ): Promise<string> {
    return this.withInterface(async (rl) => {
      const suffix = opts?.example ? ` (e.g. ${opts.example})` : '';
      const def = opts?.defaultValue ? ` [${opts.defaultValue}]` : '';
      const answer = (await rl.question(`${label}${suffix}${def}: `)).trim();
      if (!answer && opts?.defaultValue) return opts.defaultValue;
      return answer;
    });
  }

  async password(label: string): Promise<string> {
    return this.withInterface(async (rl, mut) => {
      const promise = rl.question(`${label}: `);
      mut.muted = true;
      const value = await promise;
      mut.muted = false;
      process.stdout.write('\n');
      return value;
    });
  }

  async number(label: string, opts?: { example?: string }): Promise<number> {
    // Loop until parseable.
    for (;;) {
      const raw = await this.text(label, opts);
      const n = Number(raw);
      if (raw && Number.isFinite(n)) return n;
      process.stdout.write('Please enter a number.\n');
    }
  }

  async menu<K extends string>(
    label: string,
    choices: Array<{ key: K; label: string }>,
  ): Promise<K> {
    return this.withInterface(async (rl) => {
      process.stdout.write(`${label}\n`);
      choices.forEach((c, i) => {
        process.stdout.write(`  ${i + 1}) ${c.label}\n`);
      });
      for (;;) {
        const ans = (await rl.question('Select [1]: ')).trim();
        const idx = ans === '' ? 0 : Number(ans) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < choices.length) {
          const choice = choices[idx];
          if (choice) return choice.key;
        }
        process.stdout.write(`Enter a number between 1 and ${choices.length}.\n`);
      }
    });
  }

  async selectMany<K extends string>(
    label: string,
    choices: Array<{ key: K; label: string }>,
  ): Promise<K[]> {
    return this.withInterface(async (rl) => {
      process.stdout.write(`${label}\n`);
      choices.forEach((c, i) => {
        process.stdout.write(`  ${i + 1}) ${c.label}\n`);
      });
      process.stdout.write('Enter comma-separated numbers, or "all" for everything.\n');
      for (;;) {
        const ans = (await rl.question('Select: ')).trim();
        if (!ans) {
          process.stdout.write('Pick at least one.\n');
          continue;
        }
        if (ans.toLowerCase() === 'all') return choices.map((c) => c.key);
        const parts = ans.split(',').map((s) => s.trim()).filter(Boolean);
        const out: K[] = [];
        let ok = true;
        for (const p of parts) {
          const idx = Number(p) - 1;
          if (!Number.isInteger(idx) || idx < 0 || idx >= choices.length) {
            ok = false;
            break;
          }
          const choice = choices[idx];
          if (choice && !out.includes(choice.key)) out.push(choice.key);
        }
        if (ok && out.length > 0) return out;
        process.stdout.write(`Enter comma-separated numbers between 1 and ${choices.length}.\n`);
      }
    });
  }

  async confirm(label: string, opts?: { defaultYes?: boolean }): Promise<boolean> {
    return this.withInterface(async (rl) => {
      const def = opts?.defaultYes ? 'Y/n' : 'y/N';
      const ans = (await rl.question(`${label} [${def}]: `)).trim().toLowerCase();
      if (!ans) return opts?.defaultYes ?? false;
      return ans === 'y' || ans === 'yes';
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton + DI for tests
// ---------------------------------------------------------------------------

let active: Prompter = new ReadlinePrompter();

export function getPrompter(): Prompter {
  return active;
}

/**
 * Inject a fake Prompter for testing. Returns a restore function.
 */
export function setPrompter(p: Prompter): () => void {
  const previous = active;
  active = p;
  return () => {
    active = previous;
  };
}
