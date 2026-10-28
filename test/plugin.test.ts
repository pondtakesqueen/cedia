import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');

// A plugin in the Claude Code layout: a manifest in .claude-plugin, one skill, one command, an MCP server that
// names its folder, hooks and an agent.
function fixture(dir: string, name = 'demo', greeting = 'Say hello to $ARGUMENTS.') {
  const p = join(dir, name);
  mkdirSync(join(p, '.claude-plugin'), { recursive: true });
  writeFileSync(join(p, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.2.0', description: 'a demo' }));
  mkdirSync(join(p, 'skills', 'tidy'), { recursive: true });
  writeFileSync(join(p, 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\ndescription: Tidy a module before a change\n---\n\nRead the module first.\n');
  mkdirSync(join(p, 'commands'), { recursive: true });
  writeFileSync(join(p, 'commands', 'greet.md'), `---\ndescription: Greet someone\nargument-hint: <name>\n---\n\n${greeting}\n`);
  writeFileSync(join(p, 'commands', 'clean_gone.md'), '# Clean branches whose remote is gone\n\n- Branches: !`git branch -vv`\n');
  writeFileSync(join(p, '.mcp.json'), JSON.stringify({ mcpServers: { srv: { type: 'stdio', command: '${CLAUDE_PLUGIN_ROOT}/bin/srv', args: ['--root', '${CLAUDE_PLUGIN_ROOT}'] } } }));
  mkdirSync(join(p, 'hooks'), { recursive: true });
  writeFileSync(join(p, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch /tmp/pwned' }] }] } }));
  mkdirSync(join(p, 'agents'), { recursive: true });
  writeFileSync(join(p, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview.\n');
  return p;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-plug-'));
  const home = join(dir, '.home');
  mkdirSync(home, { recursive: true });
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const env = { ...process.env, CEDIA_HOME: home };
  const run = (...args: string[]) => Bun.spawnSync([BIN, ...args], { env, cwd: work });
  return { dir, home, work, env, run };
}

describe('plugins (offline)', () => {
  test('an installed plugin adds its skills and commands; disable and uninstall take them away', () => {
    const { dir, home, work, run } = setup();
    const src = fixture(dir);
    const inst = run('plugin', 'install', src);
    expect(inst.exitCode).toBe(0);
    const said = inst.stdout.toString();
    expect(said).toContain('installed demo@1.2.0: 1 skill(s), 2 command(s)');
    expect(said).toContain('cedia plugin mcp demo');
    expect(said).toContain('hooks and agents are not run');
    expect(existsSync(join(home, 'plugins', 'demo', 'skills', 'tidy', 'SKILL.md'))).toBe(true);

    const skills = run('skills', '--cwd', work).stdout.toString();
    expect(skills).toContain('demo:tidy  (plugin)');
    expect(skills).toContain('demo:greet  (plugin)');
    // No front matter: the first line describes it; an underscore is a command name Claude Code allows.
    expect(skills).toContain('demo:clean_gone  (plugin)');
    expect(skills).toContain('Clean branches whose remote is gone');
    const commands = JSON.parse(run('commands', '--json', '--cwd', work).stdout.toString());
    expect(commands.commands.find((c: { name: string }) => c.name === 'demo:greet')).toMatchObject({ source: 'plugin', argumentHint: '<name>' });

    const show = run('plugin', 'show', 'demo').stdout.toString();
    expect(show).toContain('/demo:greet');
    expect(show).toContain('mcp servers: srv');
    expect(show).toContain('hooks: yes (not run by cedia)');

    expect(run('plugin', 'disable', 'demo').exitCode).toBe(0);
    expect(run('skills', '--cwd', work).stdout.toString()).not.toContain('demo:');
    expect(run('plugin', 'enable', 'demo').exitCode).toBe(0);
    expect(run('plugin', 'uninstall', 'demo').exitCode).toBe(0);
    expect(existsSync(join(home, 'plugins', 'demo'))).toBe(false);
    expect(run('skills', '--cwd', work).stdout.toString()).not.toContain('demo:');
  });

  test('the skill tool reads a command and a skill, and a /plugin:command prompt asks for it', async () => {
    const { dir, home, work, run } = setup();
    expect(run('plugin', 'install', fixture(dir)).exitCode).toBe(0);
    const { loadSkills, skillTool, skillCommand, skillsBlock } = await import('../src/core/skills/skills.ts');
    const skills = loadSkills(work, home);
    const tool = skillTool(skills);
    const ctx = { cwd: work, signal: new AbortController().signal } as any;
    const greet = await tool.run({ name: 'demo:greet' }, ctx);
    expect(greet.isError).toBe(false);
    expect(greet.text).toContain('from the demo plugin');
    expect(greet.text).toContain('$ARGUMENTS');
    expect(greet.text).toContain('read the text the user wrote after the command');
    expect((await tool.run({ name: 'demo:clean_gone' }, ctx)).text).toContain('run that command with bash first');
    expect(skillCommand('/demo:clean_gone', skills)).toContain('demo:clean_gone skill');
    const tidy = await tool.run({ name: 'demo:tidy' }, ctx);
    expect(tidy.text).toContain('Read the module first.');
    // A command is one file: the file argument cannot reach its neighbours.
    expect((await tool.run({ name: 'demo:greet', file: '../.mcp.json' }, ctx)).text).not.toContain('mcpServers');
    expect(skillsBlock(skills)).toContain("demo:greet (a plugin's): Greet someone");
    expect(skillCommand('/demo:greet Ada', skills)).toContain('(/demo:greet is the demo:greet skill');
  });

  test('a plugin MCP server starts only after cedia plugin mcp, with the plugin folder filled in, and leaves with it', () => {
    const { dir, home, run } = setup();
    expect(run('plugin', 'install', fixture(dir)).exitCode).toBe(0);
    const settings = join(home, 'settings.json');
    expect(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')).mcpServers?.['demo-srv'] : undefined).toBeUndefined();
    const add = run('plugin', 'mcp', 'demo');
    expect(add.exitCode).toBe(0);
    expect(add.stdout.toString()).toContain('demo-srv');
    const server = JSON.parse(readFileSync(settings, 'utf8')).mcpServers['demo-srv'];
    expect(server).toEqual({ command: join(home, 'plugins', 'demo', 'bin', 'srv'), args: ['--root', join(home, 'plugins', 'demo')] });
    expect(run('plugin', 'uninstall', 'demo').exitCode).toBe(0);
    expect(JSON.parse(readFileSync(settings, 'utf8')).mcpServers?.['demo-srv']).toBeUndefined();
  });

  test('install from a marketplace folder, and update installs from it again', () => {
    const { dir, home, run } = setup();
    const market = join(dir, 'market');
    fixture(join(market, 'plugins'));
    mkdirSync(join(market, '.claude-plugin'), { recursive: true });
    writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'local', plugins: [{ name: 'demo', source: './plugins/demo' }, { name: 'escape', source: '../..' }] }));
    expect(run('marketplace', 'add', 'local', market).exitCode).toBe(0);
    expect(run('plugin', 'install', 'demo@local').exitCode).toBe(0);
    expect(readFileSync(join(home, 'plugins', 'demo', 'commands', 'greet.md'), 'utf8')).toContain('Say hello');
    fixture(join(market, 'plugins'), 'demo', 'Say goodbye to $ARGUMENTS.');
    expect(run('plugin', 'update', 'demo').exitCode).toBe(0);
    expect(readFileSync(join(home, 'plugins', 'demo', 'commands', 'greet.md'), 'utf8')).toContain('Say goodbye');
    const escape = run('plugin', 'install', 'escape@local');
    expect(escape.exitCode).not.toBe(0);
    expect(escape.stderr.toString()).toContain('outside marketplace local');
  });

  test('a plugin whose name is a path is refused and nothing outside the plugins directory is touched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-plug-'));
    const home = join(dir, '.home');
    const keep = join(home, 'keep');
    mkdirSync(keep, { recursive: true });
    writeFileSync(join(keep, 'note'), 'x');
    const fx = join(dir, 'fx');
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, 'plugin.json'), JSON.stringify({ name: '../keep' }));
    const inst = Bun.spawnSync([BIN, 'plugin', 'install', fx], { env: { ...process.env, CEDIA_HOME: home } });
    expect(inst.exitCode).not.toBe(0);
    expect(existsSync(join(keep, 'note'))).toBe(true);
  });

  test('marketplace add/list/remove', () => {
    const { run } = setup();
    run('marketplace', 'add', 'local', '/tmp/src');
    expect(JSON.parse(run('marketplace', 'list', '--json').stdout.toString()).length).toBe(1);
    run('marketplace', 'remove', 'local');
    expect(run('marketplace', 'list').stdout.toString()).toContain('no marketplaces');
  });
});

describe('project plugin loading', () => {
  test('a project directory never contributes plugins, and a record pointing outside ~/.cedia/plugins is ignored', async () => {
    const { discoverPlugins } = await import('../src/core/plugins/plugins.ts');
    const dir = mkdtempSync(join(tmpdir(), 'cedia-plugrepo-'));
    const home = join(dir, '.home');
    mkdirSync(join(home, 'plugins'), { recursive: true });
    const evil = join(dir, 'repo', '.cedia', 'plugins', 'evil');
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, 'plugin.json'), JSON.stringify({ name: 'evil', version: '1.0.0' }));
    expect(discoverPlugins(home)).toEqual([]);
    writeFileSync(join(home, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { evil: { name: 'evil', version: '1.0.0', installPath: evil, installedAt: '', lastUpdated: '', enabled: true } } }));
    expect(discoverPlugins(home)).toEqual([]);
  });
});
