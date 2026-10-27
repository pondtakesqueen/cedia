import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cediaHome } from '../../core/config.ts';

export type OnboardingState = { completed: string[]; hasTrustDialogAccepted?: boolean };

const path = (home = cediaHome()) => join(home, 'onboarding.json');

export function loadOnboarding(home = cediaHome()): OnboardingState {
  if (!existsSync(path(home))) return { completed: [] };
  try { return JSON.parse(readFileSync(path(home), 'utf8')) as OnboardingState; } catch { return { completed: [] }; }
}
export function saveOnboarding(state: OnboardingState, home = cediaHome()) {
  mkdirSync(home, { recursive: true });
  writeFileSync(path(home), JSON.stringify(state, null, 2) + '\n');
}
export function isComplete(home = cediaHome()): boolean {
  return loadOnboarding(home).completed.length >= 4;
}
export function acceptTrust(home = cediaHome()) {
  const s = loadOnboarding(home);
  s.hasTrustDialogAccepted = true;
  if (!s.completed.includes('trust')) s.completed.push('trust');
  saveOnboarding(s, home);
}
export function markStep(step: string, home = cediaHome()) {
  const s = loadOnboarding(home);
  if (!s.completed.includes(step)) s.completed.push(step);
  saveOnboarding(s, home);
}

export const ONBOARDING_STEPS = ['preflight', 'theme', 'apiKey', 'trust', 'terminal'];