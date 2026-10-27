export type Command = { name: string; description: string };

export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

export class CommandPicker {
  private commands: Command[];
  private index = 0;
  private query = '';
  constructor(commands: Command[]) { this.commands = commands; }
  setQuery(q: string) { this.query = q; this.index = 0; }
  filtered(): Command[] { return filterCommands(this.commands, this.query); }
  up() { const f = this.filtered(); if (f.length) this.index = (this.index - 1 + f.length) % f.length; }
  down() { const f = this.filtered(); if (f.length) this.index = (this.index + 1) % f.length; }
  selected(): Command | undefined { return this.filtered()[this.index]; }
  close() { this.index = 0; this.query = ''; }
}
