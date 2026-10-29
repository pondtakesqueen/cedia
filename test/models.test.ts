import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG } from '../src/core/providers/catalog.ts';
import { modelList, type ModelList } from '../src/core/providers/models.ts';

const byRef = (l: ModelList, ref: string) => l.models.find((m) => m.ref === ref);

describe('modelList', () => {
  test('a model is available when its key is set, and says which key when not', () => {
    const l = modelList('opencode-go/deepseek-v4.1-flash', { OPENCODE_API_KEY: 'k' }, undefined);
    expect(l.default).toBe('opencode-go/deepseek-v4.1-flash');
    expect(l.models).toHaveLength(CATALOG.length);
    expect(byRef(l, 'opencode-go/deepseek-v4.1-flash')).toEqual({
      ref: 'opencode-go/deepseek-v4.1-flash',
      alias: 'deepseek',
      label: 'DeepSeek V4.1 Flash',
      provider: 'opencode-go',
      available: true,
      contextWindow: expect.any(Number),
      effort: false,
    });
    const opus = byRef(l, 'anthropic/claude-opus-5-5');
    expect(opus).toMatchObject({ alias: 'opus', label: 'Claude Opus 5.5', provider: 'anthropic', available: false, effort: true });
    expect(opus?.reason).toBe('ANTHROPIC_API_KEY (or CEDIA_ANTHROPIC_API_KEY) is not set');
    // A picker offers the levels the model takes and marks where a run starts without one.
    expect(opus).toMatchObject({ effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' });
    expect(byRef(l, 'anthropic/claude-haiku-5-5')?.defaultEffort).toBe('medium');
    expect(byRef(l, 'opencode-go/grok-4.7')?.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(byRef(l, 'anthropic/claude-opus-5-5-fast')?.label).toBe('Claude Opus 5.5 (fast)');
    expect(byRef(l, 'anthropic/claude-haiku-5-5')?.alias).toBeUndefined();
  });

  test('the alternate env name and the Keychain count as a key', () => {
    const alt = modelList('opus', { CEDIA_ANTHROPIC_API_KEY: 'k' }, undefined);
    expect(byRef(alt, 'anthropic/claude-sonnet-5-5')?.available).toBe(true);
    const kc = modelList('opus', {}, (name) => (name === 'DEEPSEEK_API_KEY' ? 'k' : undefined));
    expect(byRef(kc, 'deepseek/deepseek-v4.1-flash')?.available).toBe(true);
    expect(byRef(kc, 'opencode-go/grok-4.7')?.reason).toBe('OPENCODE_API_KEY is not set or in the Keychain');
  });

  test('the faux model is listed only with a script', () => {
    expect(byRef(modelList('x', {}, undefined), 'faux/scripted')).toBeUndefined();
    expect(byRef(modelList('x', { CEDIA_FAUX_SCRIPT: '/s.json' }, undefined), 'faux/scripted')).toMatchObject({ alias: 'faux', available: true, provider: 'faux' });
  });
});

describe('cedia models', () => {
  const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
  const run = (env: Record<string, string>, args: string[]) => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-models-'));
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY$|^CEDIA_MODEL$|^CEDIA_FAUX_SCRIPT$/.test(k)));
    return { home, run: () => Bun.spawnSync([BIN, 'models', ...args], { env: { ...clean, CEDIA_HOME: home, CEDIA_KEYCHAIN: 'off', ...env }, stdin: 'ignore' }) };
  };

  test('--json gives the code role default from settings, and the keys present', () => {
    const r = run({ OPENCODE_API_KEY: 'k' }, ['--json']);
    writeFileSync(join(r.home, 'settings.json'), JSON.stringify({ roles: { code: 'sonnet' } }));
    const proc = r.run();
    expect(proc.exitCode).toBe(0);
    const l = JSON.parse(proc.stdout.toString()) as ModelList;
    expect(l.default).toBe('anthropic/claude-sonnet-5-5');
    expect(byRef(l, 'opencode-go/beam-free')?.available).toBe(true);
    expect(byRef(l, 'anthropic/claude-sonnet-5-5')?.available).toBe(false);
  });

  test('CEDIA_MODEL wins over settings, and the table marks the default', () => {
    const proc = run({ CEDIA_MODEL: 'haiku' }, []).run();
    expect(proc.exitCode).toBe(0);
    const line = proc.stdout.toString().split('\n').find((l) => l.startsWith('*'));
    expect(line).toContain('opencode-go/claude-haiku-5-5 (haiku)');
  });

  test('the version names the capability', () => {
    const proc = Bun.spawnSync([BIN, '--version', '--json'], { stdin: 'ignore' });
    expect(JSON.parse(proc.stdout.toString()).capabilities).toContain('models');
  });
});
