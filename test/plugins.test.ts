import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHooks, loadMcp } from '../src/core/config.ts';
import { runHook, type HookInput } from '../src/core/hooks.ts';
import { runPrompt, type RunOptions } from '../src/core/loop/run.ts';
import { listMcp } from '../src/core/mcp/manage.ts';
import { cediaToolInput, claudeHookInput, claudeMatches } from '../src/core/plugins/claude-hooks.ts';
import { addPlugin, parseSource, removePlugin, setPluginHooks, setPluginMcp, updatePlugin } from '../src/core/plugins/install.ts';
import { pluginEntry, readPlugins } from '../src/core/plugins/registry.ts';
import { FAUX_MODEL } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, toolUse } from '../src/core/providers/faux.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { commandList, loadSkills, skillCommand, skillsBlock, skillTool } from '../src/core/skills/skills.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import type { EventOf, SessionEvent } from '../src/core/types.ts';
import { main } from '../src/cli.ts';

const saved = { home: process.env.CEDIA_HOME, plugins: process.env.CEDIA_PLUGINS_DIR };
let home = '';
let base = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cedia-plugins-home-'));
  base = mkdtempSync(join(tmpdir(), 'cedia-plugins-dir-'));
  process.env.CEDIA_HOME = home;
  process.env.CEDIA_PLUGINS_DIR = base;
});
afterAll(() => {
  for (const [k, v] of [
    ['CEDIA_HOME', saved.home],
    ['CEDIA_PLUGINS_DIR', saved.plugins],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const write = (root: string, files: Record<string, string>) => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
};
const json = (v: unknown) => JSON.stringify(v, null, 2);
const server = join(import.meta.dir, 'mcp', 'server.ts');
const ctx = { cwd: '/', signal: new AbortController().signal } as never;
const of = <K extends SessionEvent['kind']>(events: SessionEvent[], k: K) => events.filter((e): e is EventOf<K> => e.kind === k);

// A plugin as Claude Code lays one out, with one of each component.
function claudePlugin(name = 'deploy-tools') {
  return write(mkdtempSync(join(tmpdir(), 'cedia-plugin-src-')), {
    '.claude-plugin/plugin.json': json({ name, version: '1.2.0', description: 'Deploy helpers', author: { name: 'A' } }),
    'skills/release/SKILL.md': '---\nname: release\ndescription: Use when cutting a release\n---\nRun `${CLAUDE_PLUGIN_ROOT}/scripts/release.sh` from ${CLAUDE_SKILL_DIR}.\n',
    'scripts/release.sh': '#!/bin/sh\necho released\n',
    'commands/status.md': '---\ndescription: Show the deploy status\nargument-hint: "[env]"\nallowed-tools: Bash(git status:*)\n---\nShow the status of $ARGUMENTS.\n\n- Branch: !`git branch --show-current`\n',
    'commands/git/tag.md': '# Tag the release\n\nTag $1.\n',
    'commands/release.md': '---\ndescription: shadowed by the skill\n---\nnot used\n',
    'agents/reviewer.md': '---\nname: reviewer\n---\nReview.\n',
    'hooks/hooks.json': json({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'grep -q "rm -rf" && { echo "no rm -rf, says $CLAUDE_PLUGIN_ROOT" >&2; exit 2; }; exit 0' }] }],
        PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'echo \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"formatted"}}\'' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'notify', async: true }] }],
      },
    }),
    '.mcp.json': json({ mcpServers: { echo: { command: 'bun', args: [server], env: { WHERE: '${CLAUDE_PLUGIN_ROOT}' } }, stream: { type: 'sse', url: 'https://example.com/sse' } } }),
  });
}

describe('sources', () => {
  test('a folder, owner/repo, GitHub URLs and pi git specs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-src-'));
    expect(parseSource(dir)).toEqual({ path: dir });
    expect(parseSource('obra/superpowers-not-a-folder')).toEqual({ git: 'https://github.com/obra/superpowers-not-a-folder.git' });
    expect(parseSource('github:a/b', 'v1')).toEqual({ git: 'https://github.com/a/b.git', ref: 'v1' });
    expect(parseSource('https://github.com/a/b/tree/main/plugins/x')).toEqual({ git: 'https://github.com/a/b.git', ref: 'main', subdir: 'plugins/x' });
    expect(parseSource('git:github.com/a/b@v2')).toEqual({ git: 'https://github.com/a/b', ref: 'v2' });
    expect(parseSource('git@github.com:a/b.git')).toEqual({ git: 'git@github.com:a/b.git' });
    expect(() => parseSource('npm:@a/b')).toThrow(/npm packages are not supported/);
    expect(() => parseSource('no such thing here')).toThrow(/not a git URL/);
  });
});

describe('a Claude Code plugin', () => {
  test('skills load at once, commands become skills, and agents and unsupported hooks are listed as skipped', () => {
    const p = addPlugin(home, { source: claudePlugin() }, base);
    expect(p).toMatchObject({ name: 'deploy-tools', version: '1.2.0', format: 'claude-code', mcp: { enabled: false, added: [] }, hooks: { enabled: false } });
    expect(p.skills.map((s) => [s.name, s.from])).toEqual([
      ['release', 'skill'],
      ['git-tag', 'command'],
      ['status', 'command'],
    ]);
    expect(p.skipped).toEqual([
      'agent agents/reviewer.md: agents are not supported yet',
      'command release: a skill of the same name comes first',
      'MCP server stream: sse servers are not supported (cedia speaks stdio and streamable HTTP)',
      'SessionStart hooks: cedia runs PreToolUse, PostToolUse and Stop hooks only',
      'Stop hook notify: background hooks are not supported',
    ]);
    expect(existsSync(join(base, 'deploy-tools', 'src', 'scripts', 'release.sh'))).toBe(true);

    const cwd = mkdtempSync(join(tmpdir(), 'cedia-plugins-cwd-'));
    const skills = loadSkills(cwd, home);
    expect(skills.map((s) => [s.name, s.source, s.plugin])).toEqual([
      ['release', 'plugin', 'deploy-tools'],
      ['git-tag', 'plugin', 'deploy-tools'],
      ['status', 'plugin', 'deploy-tools'],
    ]);
    expect(skillsBlock(skills)).toContain('- status (plugin deploy-tools): Show the deploy status');
    expect(commandList(skills).commands.find((c) => c.name === 'status')).toEqual({ name: 'status', description: 'Show the deploy status', kind: 'skill', source: 'plugin', argumentHint: '[env]', plugin: 'deploy-tools' });
    expect(skillCommand('/deploy-tools:status prod', skills)).toContain('load it with the skill tool first');
    expect(skillCommand('/other:status prod', skills)).toBeUndefined();
    return Promise.all([
      skillTool(skills)
        .run({ name: 'release' }, ctx)
        .then((r) => {
          expect(r.text).toContain('from the plugin deploy-tools, which the user installed');
          expect(r.text).toContain(`Run \`${join(base, 'deploy-tools', 'src')}/scripts/release.sh\` from ${join(base, 'deploy-tools', 'src', 'skills', 'release')}.`);
        }),
      skillTool(skills)
        .run({ name: 'status' }, ctx)
        .then((r) => {
          expect(r.text).toContain('`$ARGUMENTS` in it stands for the text typed after the command');
          expect(r.text).toContain('run it yourself where you need the output');
          expect(r.text).toContain('Show the status of $ARGUMENTS.');
        }),
    ]);
  });

  test('a user skill keeps its name; the plugin\'s is renamed <plugin>-<name>', () => {
    write(home, { 'skills/release/SKILL.md': '---\nname: release\ndescription: mine\n---\nx\n' });
    addPlugin(home, { source: claudePlugin() }, base);
    expect(loadSkills(mkdtempSync(join(tmpdir(), 'cedia-plugins-cwd-')), home).map((s) => [s.name, s.source])).toEqual([
      ['release', 'user'],
      ['deploy-tools-release', 'plugin'],
      ['git-tag', 'plugin'],
      ['status', 'plugin'],
    ]);
  });

  test('MCP servers go into mcpServers only when turned on, and out again when off or removed', async () => {
    addPlugin(home, { source: claudePlugin() }, base);
    expect(listMcp().servers).toEqual([]);
    const on = setPluginMcp(home, 'deploy-tools', true);
    expect(on.mcp).toMatchObject({ enabled: true, added: ['deploy-tools-echo'] });
    const root = join(base, 'deploy-tools', 'src');
    expect(loadMcp()['deploy-tools-echo']).toEqual({ command: 'bun', args: [server], env: { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: join(base, 'deploy-tools', 'data'), WHERE: root }, cwd: root });
    expect(pluginEntry(on).mcp.servers).toEqual([{ name: 'echo', command: `bun ${server}`, env: ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'WHERE'] }]);
    setPluginMcp(home, 'deploy-tools', false);
    expect(listMcp().servers).toEqual([]);
    setPluginMcp(home, 'deploy-tools', true);
    removePlugin(home, 'deploy-tools', base);
    expect(listMcp().servers).toEqual([]);
    expect(readPlugins(home).plugins).toEqual([]);
    expect(existsSync(join(base, 'deploy-tools'))).toBe(false);
  });

  test('a server name of the user\'s is not taken over', () => {
    addPlugin(home, { source: claudePlugin() }, base);
    writeFileSync(join(home, 'settings.json'), json({ mcpServers: { 'deploy-tools-echo': { command: 'mine' } } }));
    expect(() => setPluginMcp(home, 'deploy-tools', true)).toThrow(/already an MCP server deploy-tools-echo/);
    expect(loadMcp()['deploy-tools-echo']).toEqual({ command: 'mine' });
  });

  test('hooks run only once turned on, through the adapter, after the user\'s own', async () => {
    writeFileSync(join(home, 'settings.json'), json({ hooks: { preToolUse: [{ command: ['true'] }] } }));
    addPlugin(home, { source: claudePlugin() }, base);
    expect(loadHooks().preToolUse).toHaveLength(1);
    setPluginHooks(home, 'deploy-tools', true);
    const hooks = loadHooks();
    expect(hooks.preToolUse?.map((h) => h.claude?.plugin ?? h.command[0])).toEqual(['true', 'deploy-tools']);
    expect(hooks.postToolUse?.[0]?.claude?.matcher).toBe('Edit|Write');

    const cwd = mkdtempSync(join(tmpdir(), 'cedia-plugins-cwd-'));
    const log = SessionLog.create();
    const opts: RunOptions = {
      log,
      provider: fauxProvider([{ blocks: [toolUse('c1', 'bash', { command: 'rm -rf build' }), toolUse('c2', 'bash', { command: 'echo hi' })] }, { blocks: [text('ok')] }]),
      model: FAUX_MODEL,
      tools: [bashTool],
      system: 'sys',
      cwd,
      hooks: { preToolUse: hooks.preToolUse!.slice(1), postToolUse: hooks.postToolUse },
      hookHome: home,
      permission: { mode: 'workspace', allow: [], deny: [] },
    };
    await runPrompt(opts, 'clean');
    const [p1, p2] = of(log.events, 'permission');
    expect(p1).toMatchObject({ callId: 'c1', decision: 'deny', rule: 'hook:preToolUse[0] plugin deploy-tools', reason: `no rm -rf, says ${join(base, 'deploy-tools', 'src')}` });
    expect(p2).toMatchObject({ callId: 'c2', decision: 'allow' });
    // The post hook matches Edit|Write, so it never ran for bash.
    expect(of(log.events, 'hook').map((h) => h.event)).toEqual(['preToolUse', 'preToolUse']);
    expect(lintSession(log.events)).toEqual([]);
  });

  test('update keeps servers and hooks on when nothing changed, and turns them off when the plugin did', () => {
    const src = claudePlugin();
    addPlugin(home, { source: src }, base);
    setPluginMcp(home, 'deploy-tools', true);
    setPluginHooks(home, 'deploy-tools', true);
    writeFileSync(join(base, 'deploy-tools', 'data', 'state'), 'kept');
    // A folder copied again could hold anything new, so a folder source always counts as changed.
    const u = updatePlugin(home, 'deploy-tools', false, base);
    expect(u).toMatchObject({ changed: true, turnedOff: ['mcp', 'hooks'] });
    expect(u.record.mcp.enabled).toBe(false);
    expect(listMcp().servers).toEqual([]);
    expect(readFileSync(join(base, 'deploy-tools', 'data', 'state'), 'utf8')).toBe('kept');
    setPluginMcp(home, 'deploy-tools', true);
    const kept = updatePlugin(home, 'deploy-tools', true, base);
    expect(kept.turnedOff).toEqual([]);
    expect(listMcp().servers.map((s) => s.name)).toEqual(['deploy-tools-echo']);
  });

  test('a git source is cloned and its commit recorded; a second add of the name is refused', () => {
    const src = claudePlugin();
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x']]) Bun.spawnSync(['git', ...args], { cwd: src });
    const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: src }).stdout.toString().trim();
    const p = addPlugin(home, { source: `file://${src}` }, base);
    expect(p).toMatchObject({ source: { git: `file://${src}` }, commit: head });
    expect(() => addPlugin(home, { source: `file://${src}` }, base)).toThrow(/already installed/);
    expect(addPlugin(home, { source: `file://${src}`, name: 'second' }, base).name).toBe('second');
    expect(updatePlugin(home, 'deploy-tools', false, base).changed).toBe(false);
  });
});

describe('other layouts', () => {
  test('a marketplace: one entry is picked by --plugin, and a relative source installs from inside it', () => {
    const m = write(mkdtempSync(join(tmpdir(), 'cedia-market-')), {
      '.claude-plugin/marketplace.json': json({ name: 'm', owner: { name: 'o' }, plugins: [{ name: 'a', source: './plugins/a' }, { name: 'b', source: './plugins/b' }] }),
      'plugins/a/skills/x/SKILL.md': '---\nname: x\ndescription: from a\n---\n',
      'plugins/b/commands/y.md': 'Do y.\n',
    });
    expect(() => addPlugin(home, { source: m }, base)).toThrow(/marketplace of 2 plugins; pick one with --plugin <name> \(a, b\)/);
    expect(() => addPlugin(home, { source: m, plugin: 'c' }, base)).toThrow(/no plugin c/);
    const b = addPlugin(home, { source: m, plugin: 'b' }, base);
    expect(b).toMatchObject({ name: 'b', format: 'skills', source: { path: m, subdir: 'plugins/b' } });
    expect(b.skills.map((s) => s.name)).toEqual(['y']);
  });

  test('a pi package: its skills and prompts load, its extensions are skipped', () => {
    const src = write(mkdtempSync(join(tmpdir(), 'cedia-pi-')), {
      'package.json': json({ name: '@me/pi-tools', keywords: ['pi-package'], pi: { extensions: ['./src/ext.ts'], skills: ['./res/skills'], prompts: ['./res/prompts/*.md'] } }),
      'src/ext.ts': 'export default () => {}\n',
      'res/skills/lint/SKILL.md': '---\nname: lint\ndescription: Lint the code\n---\n',
      'res/prompts/review.md': '---\ndescription: Review staged changes\n---\nReview, focusing on ${1:-correctness}.\n',
    });
    const p = addPlugin(home, { source: src }, base);
    expect(p).toMatchObject({ name: 'me-pi-tools', format: 'pi', skipped: ["extension src/ext.ts: pi extensions are code written for pi's own API"] });
    expect(p.skills.map((s) => [s.name, s.from])).toEqual([
      ['lint', 'skill'],
      ['review', 'command'],
    ]);
  });

  test('a Codex plugin: skills from its manifest, servers from .mcp.json', () => {
    const src = write(mkdtempSync(join(tmpdir(), 'cedia-codex-')), {
      '.codex-plugin/plugin.json': json({ name: 'cx', version: '1.0.0', skills: './my-skills/' }),
      'my-skills/plan/SKILL.md': '---\nname: plan\ndescription: Plan first\n---\n',
      '.mcp.json': json({ mcpServers: { docs: { url: 'https://example.com/mcp', headers: { authorization: 'Bearer ${DOCS_TOKEN}' } } } }),
    });
    const p = addPlugin(home, { source: src }, base);
    expect(p).toMatchObject({ name: 'cx', format: 'codex', skipped: [] });
    expect(p.skills.map((s) => s.name)).toEqual(['plan']);
    expect(p.mcp.servers).toEqual({ docs: { url: 'https://example.com/mcp', headers: { authorization: 'Bearer ${DOCS_TOKEN}' } } });
  });

  test('a bare folder with SKILL.md at its root is one skill', () => {
    const src = write(mkdtempSync(join(tmpdir(), 'cedia-bare-')), { 'SKILL.md': '---\nname: solo\ndescription: One skill\n---\n' });
    expect(addPlugin(home, { source: src, name: 'solo-skill' }, base).skills.map((s) => s.name)).toEqual(['solo']);
  });
});

describe('the Claude Code hook adapter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-cchooks-'));
  const claude = { plugin: 'p', root: dir, data: dir, form: 'shell' as const };
  const pre: HookInput = { event: 'preToolUse', sessionId: 's', cwd: '/work', tool: 'edit', callId: 'c1', input: { path: 'a.ts', edits: [{ old_text: 'x', new_text: 'y' }] } };
  const sh = (body: string) => ({ command: ['sh', '-c', body], claude });

  test('matchers: all, exact lists, and regular expressions over Claude Code\'s tool names', () => {
    expect(claudeMatches(undefined, 'bash')).toBe(true);
    expect(claudeMatches('*', 'read')).toBe(true);
    expect(claudeMatches('Edit|Write', 'edit')).toBe(true);
    expect(claudeMatches('Edit, Write', 'write')).toBe(true);
    expect(claudeMatches('Edit|Write', 'bash')).toBe(false);
    expect(claudeMatches('^mcp__gh__.*', 'mcp__gh__search')).toBe(true);
    expect(claudeMatches('Notebook.*', 'edit')).toBe(false);
  });

  test('the call reaches the hook in Claude Code\'s shape', () => {
    expect(claudeHookInput(pre)).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/work/a.ts', old_string: 'x', new_string: 'y', replace_all: false }, tool_use_id: 'c1', cwd: '/work' });
    expect(claudeHookInput({ event: 'postToolUse', sessionId: 's', cwd: '/w', tool: 'bash', callId: 'c', input: { command: 'ls' }, output: { text: 'a', isError: false, exitCode: 0 } })).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a', exit_code: 0 } });
    expect(claudeHookInput({ event: 'stop', sessionId: 's', cwd: '/w', result: 'done', changed: [] })).toMatchObject({ hook_event_name: 'Stop', last_assistant_message: 'done', stop_hook_active: false });
    expect(cediaToolInput('edit', { file_path: 'b.ts', old_string: 'p', new_string: 'q' }, pre.input)).toEqual({ path: 'b.ts', edits: [{ old_text: 'p', new_text: 'q' }] });
  });

  test('answers: exit 2, permissionDecision, updatedInput, notes, and failures that let the step go on', async () => {
    expect(await runHook(sh('echo nope >&2; exit 2'), pre, dir)).toEqual({ decision: 'block', reason: 'nope' });
    expect(await runHook(sh(`echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"protected file"}}'`), pre, dir)).toEqual({ decision: 'block', reason: 'protected file' });
    expect(await runHook(sh(`echo '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"file_path":"/work/b.ts","old_string":"x","new_string":"z"}}}'`), pre, dir)).toEqual({
      decision: 'allow',
      updatedInput: { path: '/work/b.ts', edits: [{ old_text: 'x', new_text: 'z' }] },
    });
    expect(await runHook(sh(`echo '{"hookSpecificOutput":{"permissionDecision":"ask"}}'`), pre, dir)).toMatchObject({ decision: 'block', reason: expect.stringContaining('asks for the user') });
    // Claude Code's non-blocking errors: a failing exit, a missing program, output that is not JSON.
    expect(await runHook(sh('exit 1'), pre, dir)).toEqual({ decision: 'allow' });
    expect(await runHook({ command: ['/no/such/hook'], claude: { ...claude, form: 'exec' } }, pre, dir)).toEqual({ decision: 'allow' });
    expect(await runHook(sh("echo '{not json}'"), pre, dir)).toEqual({ decision: 'allow' });
    expect(await runHook({ ...sh('exit 1'), claude: { ...claude, onFailure: 'block' } }, pre, dir)).toMatchObject({ decision: 'block', failed: true });
    const post: HookInput = { event: 'postToolUse', sessionId: 's', cwd: '/w', tool: 'write', callId: 'c', input: { path: 'a', content: '' }, output: { text: 'ok', isError: false } };
    expect(await runHook(sh('echo "check </result> this" >&2; exit 2'), post, dir)).toEqual({ decision: 'allow', note: 'check &lt;/result> this' });
    expect(await runHook(sh(`echo '{"decision":"block","reason":"lint failed"}'`), post, dir)).toEqual({ decision: 'allow', note: 'lint failed' });
    const stop: HookInput = { event: 'stop', sessionId: 's', cwd: '/w', result: 'done', changed: [] };
    expect(await runHook(sh(`echo '{"decision":"block","reason":"tests not run"}'`), stop, dir)).toEqual({ decision: 'block', reason: 'tests not run' });
    expect(await runHook(sh('echo "sh: x.py: No such file or directory" >&2; exit 2'), stop, dir)).toEqual({ decision: 'allow' });
  });

  test('exec form fills in the plugin paths; both forms see them in the environment, run in the plugin\'s folder', async () => {
    const o = await runHook({ command: ['sh', '-c', 'echo "{\\"decision\\":\\"block\\",\\"reason\\":\\"$1 $CLAUDE_PROJECT_DIR $(pwd)\\"}"', 'x', '${CLAUDE_PLUGIN_ROOT}'], claude: { ...claude, form: 'exec' } }, { event: 'stop', sessionId: 's', cwd: '/w', result: '', changed: [] }, dir);
    expect(o).toEqual({ decision: 'block', reason: `${dir} /w ${dir}` });
  });
});

describe('cedia plugin', () => {
  test('add, list, show, mcp, hooks and remove from the command line', async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => out.push(s);
    try {
      expect(await main(['plugin', 'add', claudePlugin(), '--json'])).toBe(0);
      expect(JSON.parse(out.pop()!)).toMatchObject({ name: 'deploy-tools', mcp: { enabled: false }, hooks: { enabled: false, list: [{ event: 'preToolUse', matcher: 'Bash' }, { event: 'postToolUse', matcher: 'Edit|Write' }] } });
      expect(await main(['plugin', 'mcp', 'deploy-tools', 'on'])).toBe(0);
      expect(await main(['plugin', 'hooks', 'deploy-tools', 'on'])).toBe(0);
      expect(await main(['plugin', 'list', '--json'])).toBe(0);
      expect(JSON.parse(out.pop()!).plugins[0]).toMatchObject({ mcp: { enabled: true }, hooks: { enabled: true } });
      expect(await main(['plugin', 'show', 'deploy-tools'])).toBe(0);
      expect(out.pop()).toContain('skipped:\n    agent agents/reviewer.md');
      expect(await main(['plugin', 'remove', 'deploy-tools'])).toBe(0);
      expect(await main(['plugin', 'show', 'deploy-tools'])).toBe(1);
      expect(await main(['plugin', 'frob'])).toBe(2);
    } finally {
      console.log = log;
    }
  });
});
