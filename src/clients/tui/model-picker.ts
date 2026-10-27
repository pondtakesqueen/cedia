export type Model = { ref: string; label: string; available: boolean; reason?: string; effortLevels?: string[] };

export function groupByProvider(models: Model[]): Record<string, Model[]> {
  const out: Record<string, Model[]> = {};
  for (const m of models) {
    const provider = m.ref.split('/')[0] ?? 'unknown';
    (out[provider] ??= []).push(m);
  }
  return out;
}

export class ModelPicker {
  constructor(public models: Model[]) {}
  chip(current: string, helperCount = 0): string {
    return `${current}${helperCount ? ` +${helperCount}` : ''}`;
  }
  pick(ref: string): Model | undefined { return this.models.find((m) => m.ref === ref); }
}