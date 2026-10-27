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
export const ONBOARDING_STEPS = ['preflight', 'theme', 'apiKey', 'trust', 'terminal'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function completedNames(state: OnboardingState): ReadonlySet<OnboardingStep> {
  const known = new Set<string>(ONBOARDING_STEPS);
  const names = new Set<OnboardingStep>();
  for (const name of state.completed ?? []) {
    if (known.has(name)) names.add(name as OnboardingStep);
  }
  if (state.hasTrustDialogAccepted) names.add('trust');
  return names;
}

export function isComplete(home = cediaHome()): boolean {
  const names = completedNames(loadOnboarding(home));
  return ONBOARDING_STEPS.every((step) => names.has(step));
}

export function reconcileOnboarding(
  state: OnboardingState,
  facts: Partial<Record<OnboardingStep, boolean>>,
): OnboardingState {
  const completed = Array.isArray(state.completed) ? [...state.completed] : [];
  for (const step of ONBOARDING_STEPS) {
    if (facts[step] === true && !completed.includes(step)) completed.push(step);
  }
  const next: OnboardingState = { completed };
  if (state.hasTrustDialogAccepted || facts.trust === true) next.hasTrustDialogAccepted = true;
  return next;
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