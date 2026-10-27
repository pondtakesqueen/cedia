export type Mode = { mode: string; description: string };

export class PermissionPicker {
  constructor(public modes: Mode[]) {}
  chip(mode: string, helperCount: number): string {
    return `${mode}${helperCount ? ` +${helperCount}` : ''}`;
  }
  pick(mode: string): Mode | undefined { return this.modes.find((m) => m.mode === mode); }
}
