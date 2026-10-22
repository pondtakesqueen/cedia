import { existsSync, readFileSync } from 'node:fs';
import { delimiter, extname, join, relative } from 'node:path';
import { LspClient, type Diagnostic } from './client.ts';

// Diagnostics after each edit: when a language server for the file's language is there, the edit and write tools
// tell the model the errors the file has once written, so a type error is seen at the edit that made it, not at
// the next check. The server runs as bash does (in the OS sandbox when one is on, with the same scrubbed
// environment), since some servers run the project's own code (TypeScript plugins named in tsconfig, build
// scripts). One server per language for the run, started at the first edit it covers; one that fails to start
// is not tried again.

export type LspServer = { name: string; command: string[]; extensions: string[] };

// The servers cedia knows, used when their command is on PATH or in the project's node_modules/.bin.
export const KNOWN_SERVERS: LspServer[] = [
  { name: 'typescript', command: ['typescript-language-server', '--stdio'], extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] },
  { name: 'pyright', command: ['pyright-langserver', '--stdio'], extensions: ['.py', '.pyi'] },
  { name: 'gopls', command: ['gopls'], extensions: ['.go'] },
];

const LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

// The errors shown for one file, at most.
export const MAX_SHOWN = 10;
// How long the first diagnostics may take (the server loads the project), and later ones.
const START_MS = 20_000;
const FIRST_MS = 15_000;
const LATER_MS = 5_000;

// Where a command is: the project's node_modules/.bin first, then PATH.
export function findCommand(cmd: string, cwd: string, path = process.env.PATH ?? ''): string | undefined {
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : undefined;
  for (const dir of [join(cwd, 'node_modules', '.bin'), ...path.split(delimiter).filter(Boolean)]) {
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return undefined;
}

// The servers for this run: the known ones that are installed, then the user's own (`lsp` in settings), which
// replace a known one of the same name. `false` turns them all off.
export function lspServers(cwd: string, setting: boolean | Record<string, { command: string[]; extensions: string[] }> | undefined): LspServer[] {
  if (setting === false) return [];
  const own = typeof setting === 'object' ? Object.entries(setting).map(([name, s]) => ({ name, command: s.command, extensions: s.extensions })) : [];
  const all = [...KNOWN_SERVERS.filter((k) => !own.some((o) => o.name === k.name)), ...own];
  return all.flatMap((s) => {
    const bin = s.command[0] && findCommand(s.command[0], cwd);
    return bin ? [{ ...s, command: [bin, ...s.command.slice(1)] }] : [];
  });
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export type Diagnoser = { diagnose(file: string, signal?: AbortSignal): Promise<string | undefined>; close(): Promise<void> };

export function openDiagnoser(
  cwd: string,
  servers: LspServer[],
  opts: { wrap?: (command: string) => Promise<string>; env: Record<string, string>; warn?: (line: string) => void },
): Diagnoser {
  const clients = new Map<string, Promise<LspClient | undefined>>();
  const used = new Set<string>();
  const client = (s: LspServer) => {
    let c = clients.get(s.name);
    if (!c) {
      c = (async () => {
        try {
          const line = s.command.map(quote).join(' ');
          const argv = opts.wrap ? ['bash', '-c', await opts.wrap(line)] : s.command;
          const lsp = new LspClient(argv, cwd, opts.env);
          await lsp.start(START_MS);
          return lsp;
        } catch (e) {
          opts.warn?.(`cedia: the ${s.name} language server did not start (${(e as Error).message}); edits go on without its diagnostics`);
          return undefined;
        }
      })();
      clients.set(s.name, c);
    }
    return c;
  };
  return {
    async diagnose(file, signal) {
      const ext = extname(file);
      const s = servers.find((x) => x.extensions.includes(ext));
      if (!s) return undefined;
      const lsp = await client(s);
      if (!lsp) return undefined;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
      const first = !used.has(s.name);
      used.add(s.name);
      const got = await lsp.diagnostics(file, text, LANGUAGE[ext] ?? ext.slice(1), first ? FIRST_MS : LATER_MS, signal);
      return got && diagnosticsText(relative(cwd, file), s.name, got);
    },
    async close() {
      await Promise.all([...clients.values()].map(async (c) => (await c)?.close()));
    },
  };
}

// What the model reads after an edit: the file's errors, by line. Nothing when it has none: warnings and hints
// are left out, as a check would leave them.
export function diagnosticsText(file: string, server: string, diagnostics: Diagnostic[]): string | undefined {
  const errors = diagnostics.filter((d) => (d.severity ?? 1) === 1).sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  if (!errors.length) return undefined;
  const line = (d: Diagnostic) => `  ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message.split('\n')[0]!.slice(0, 300)}${d.code !== undefined ? ` [${d.code}]` : ''}`;
  const more = errors.length > MAX_SHOWN ? [`  and ${errors.length - MAX_SHOWN} more`] : [];
  return `${server} reports ${errors.length} error${errors.length === 1 ? '' : 's'} in ${file} as it is now:\n${errors.slice(0, MAX_SHOWN).map(line).join('\n')}${more.length ? `\n${more[0]}` : ''}`;
}
