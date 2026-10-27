export type Settings = Record<string, unknown>;

export class SettingsScreen {
  private open = false;
  constructor(private settings: Settings) {}
  toggle() { this.open = !this.open; }
  isOpen() { return this.open; }
  get(key: string) { return this.settings[key]; }
  set(key: string, value: unknown) { this.settings[key] = value; }
  render(): string {
    return Object.entries(this.settings).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  }
}
