// `cedia models --json`: the models a client may offer in a picker, and which of them this machine can send to
// now. Available means a key for it is in the environment or the Keychain, as authKey finds it; nothing is sent.
import { ALIASES, CATALOG, FAUX_MODEL } from './catalog.ts';
import { authKey } from './http.ts';
import type { Keychain } from './keychain.ts';
import type { ModelSpec } from '../types.ts';

type Env = Record<string, string | undefined>;

export type ModelEntry = {
  ref: string;
  alias?: string;
  label: string;
  provider: string;
  available: boolean;
  reason?: string; // why it is not available
  contextWindow: number;
  effort: boolean; // takes --effort
};

export type ModelList = { default: string; models: ModelEntry[] };

const LABELS: Record<string, string> = {
  'claude-fable-5-1': 'Claude Fable 5.1',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'beam-free': 'Beam (free)',
  'muse-spark-1.3-contributor': 'Muse Spark 1.3 (contributor)',
  'grok-4.7': 'Grok 4.7',
  scripted: 'Faux (scripted)',
};

export function modelLabel(m: ModelSpec): string {
  const name = LABELS[m.id] ?? m.id;
  return m.speed === 'fast' ? `${name} (fast)` : name;
}

export function modelEntry(m: ModelSpec, env: Env, keychain: Keychain | undefined): ModelEntry {
  const alias = Object.entries(ALIASES).find(([, ref]) => ref === m.ref)?.[0];
  const available = m.wire === 'faux' || !!authKey(m, env, keychain);
  const names = m.auth.altEnv ? `${m.auth.env} (or ${m.auth.altEnv})` : m.auth.env;
  return {
    ref: m.ref,
    ...(alias ? { alias } : {}),
    label: modelLabel(m),
    provider: m.ref.split('/')[0] ?? m.ref,
    available,
    ...(available ? {} : { reason: `${names} is not set${keychain ? ' or in the Keychain' : ''}` }),
    contextWindow: m.caps.contextWindow,
    effort: m.caps.effortLevels.length > 0,
  };
}

// `defaultRef` is what the code role resolves to now (loadRoles). The faux model is listed only when a script
// for it is set, as it is in offline tests.
export function modelList(defaultRef: string, env: Env, keychain: Keychain | undefined): ModelList {
  const models = [...CATALOG, ...(env.CEDIA_FAUX_SCRIPT ? [FAUX_MODEL] : [])];
  return { default: defaultRef, models: models.map((m) => modelEntry(m, env, keychain)) };
}

export function modelLine(e: ModelEntry, isDefault: boolean): string {
  const name = e.alias ? `${e.ref} (${e.alias})` : e.ref;
  return `${isDefault ? '*' : ' '} ${e.available ? ' ' : '-'} ${name.padEnd(48)} ${e.label}${e.available ? '' : `: ${e.reason}`}`;
}
