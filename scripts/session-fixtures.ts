// Records offline faux runs as fixtures for clients that replay cedia's output (the desktop's agent pane and thread
// index): test/fixtures/sessions/<scenario>/ holds the run's stream-json output, its thread file and its session
// files, with the temp paths replaced by /fixture/repo and /fixture/home. Ids and times differ on every run; the
// shape does not, and test/fixtures.test.ts checks that a fresh run still produces it.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Step = { blocks: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> })[] };
const reply = (text: string): Step => ({ blocks: [{ type: 'text', text }] });
const tool = (id: string, name: string, input: Record<string, unknown>): Step => ({ blocks: [{ type: 'tool_use', id, name, input }] });
const bash = (id: string, command: string) => tool(id, 'bash', { command });

const ws = ['--permission', 'workspace', '--sandbox', 'off'];

export type Scenario = { name: string; what: string; prompt: string; script: Step[]; args: string[] };

export const SCENARIOS: Scenario[] = [
  {
    name: 'edit-and-check',
    what: 'write a file, edit it, run the declared check, and claim done with a receipt',
    prompt: 'make f.txt say good',
    script: [
      tool('w1', 'write', { path: 'f.txt', content: 'bad\n' }),
      tool('e1', 'edit', { path: 'f.txt', edits: [{ old_text: 'bad', new_text: 'good' }] }),
      bash('c1', 'grep -q good f.txt'),
      reply('f.txt now says good, and grep -q good f.txt passes.'),
    ],
    args: [...ws, '--check', 'grep -q good f.txt'],
  },
  {
    name: 'denied-call',
    what: 'a call the deny list refuses: a permission event, a denied tool_result and no tool_intent',
    prompt: 'publish the package',
    script: [bash('c1', 'npm publish'), reply('Publishing is on the deny list, so I left it for you.')],
    args: ws,
  },
  {
    name: 'handoff',
    what: 'a long session hands off to a second session of the same thread, which recalls and verifies',
    prompt: 'make f.txt say good',
    script: [bash('c1', 'echo good > f.txt && seq 1 6000'), reply('Wrote f.txt. Next: run the check.'), bash('c2', 'grep -q good f.txt'), reply('done')],
    args: [...ws, '--check', 'grep -q good f.txt', '--handoff-at', '2000'],
  },
  {
    name: 'subthread',
    what: 'a work sub-thread writes in its own session and thread; only its report comes back',
    prompt: 'make f.txt say good',
    script: [
      tool('s1', 'spawn', { kind: 'work', task: 'Write good to f.txt, then run grep -q good f.txt.' }),
      bash('c1', 'echo good > f.txt'),
      bash('c2', 'grep -q good f.txt'),
      reply('Wrote good to f.txt; grep -q good f.txt passes.'),
      bash('c3', 'grep -q good f.txt'),
      reply('done, checked'),
    ],
    args: [...ws, '--check', 'grep -q good f.txt'],
  },
];

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
export const FIXTURES = join(import.meta.dir, '..', 'test', 'fixtures', 'sessions');

export type Recording = { stream: string; threads: Record<string, string>; sessions: Record<string, string> };

// Runs one scenario offline and returns its files, paths normalized.
export function record(s: Scenario): Recording {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-fixture-'));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  mkdirSync(repo);
  try {
    const scriptPath = join(dir, 'script.json');
    writeFileSync(scriptPath, JSON.stringify(s.script));
    const run = Bun.spawnSync([BIN, '-m', 'faux', '--cwd', repo, '-p', s.prompt, '--output-format', 'stream-json', ...s.args], {
      env: { ...process.env, CEDIA_FAUX_SCRIPT: scriptPath, CEDIA_HOME: home },
      stdin: 'ignore',
    });
    if (!run.stdout.length) throw new Error(`${s.name}: no output\n${run.stderr.toString()}`);
    const [slug] = readdirSync(join(home, 'sessions'));
    const norm = (text: string) => text.split(slug!).join('fixture-repo').split(repo).join('/fixture/repo').split(home).join('/fixture/home').split(dir).join('/fixture');
    const filesIn = (d: string) => Object.fromEntries(readdirSync(d).sort().map((f) => [f, norm(readFileSync(join(d, f), 'utf8'))]));
    return { stream: norm(run.stdout.toString()), threads: filesIn(join(home, 'projects', slug!, 'threads')), sessions: filesIn(join(home, 'sessions', slug!)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  rmSync(FIXTURES, { recursive: true, force: true });
  const index: { name: string; what: string }[] = [];
  for (const s of SCENARIOS) {
    const r = record(s);
    const out = join(FIXTURES, s.name);
    mkdirSync(join(out, 'threads'), { recursive: true });
    mkdirSync(join(out, 'sessions'), { recursive: true });
    writeFileSync(join(out, 'stream.jsonl'), r.stream);
    for (const [f, text] of Object.entries(r.threads)) writeFileSync(join(out, 'threads', f), text);
    for (const [f, text] of Object.entries(r.sessions)) writeFileSync(join(out, 'sessions', f), text);
    index.push({ name: s.name, what: s.what });
  }
  writeFileSync(join(FIXTURES, 'index.json'), JSON.stringify(index, null, 2) + '\n');
}
