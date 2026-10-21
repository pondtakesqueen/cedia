import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy } from '../src/core/config.ts';
import { decide, denyListed, insideWorkspace, type Policy } from '../src/core/safety/policy.ts';
import { simpleCommands } from '../src/core/safety/shell.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import { editTool, writeTool } from '../src/core/tools/edit.ts';
import { readTool } from '../src/core/tools/read.ts';

const cwd = mkdtempSync(join(tmpdir(), 'cedia-policy-'));
mkdirSync(join(cwd, 'src'));
const WS: Policy = { mode: 'workspace', allow: [], deny: [] };
const RO: Policy = { mode: 'read-only', allow: [], deny: [] };
const bash = (policy: Policy, command: string) => decide(policy, bashTool, { command }, cwd);

describe('shell splitting', () => {
  test('splits chains, pipes, subshells and substitutions; unwraps sudo, env and bash -c', () => {
    expect(simpleCommands('a x && b | c; d & e')).toEqual([['a', 'x'], ['b'], ['c'], ['d'], ['e']]);
    expect(simpleCommands('echo $(rm -rf /) `id`')).toEqual([['echo'], ['rm', '-rf', '/'], ['id']]);
    expect(simpleCommands('sudo -E env A=1 git push -f')).toEqual([['git', 'push', '-f']]);
    expect(simpleCommands(`bash -c "git reset --hard && ls"`)).toEqual([['git', 'reset', '--hard'], ['ls']]);
    expect(simpleCommands('if true; then rm -r /tmp/x; fi')).toEqual([['true'], ['rm', '-r', '/tmp/x']]);
    expect(simpleCommands('ls 2>&1 > out.txt | grep "a b"')).toEqual([['ls'], ['grep', 'a b']]);
    expect(simpleCommands('echo "open')).toBeNull();
  });
});

describe('deny list', () => {
  const denied: [string, string][] = [
    ['git push --force origin main', 'force-push'],
    ['git push -fu origin x', 'force-push'],
    ['git push origin +main', 'force-push'],
    ['git push --force-with-lease', 'force-push'],
    ['git push origin --delete old', 'force-push'],
    ['git -C sub push -f', 'force-push'],
    ['cd x && git reset --hard HEAD~1', 'reset-hard'],
    ['git clean -fdx', 'clean-force'],
    ['rm -rf /', 'rm-outside'],
    ['rm -rf ~', 'rm-outside'],
    ['rm -r ../other', 'rm-outside'],
    ['rm -rf .', 'rm-outside'],
    ['rm -rf "$DIR"', 'rm-outside'],
    ['find . -name x | xargs rm -rf', 'rm-outside'],
    ['find / -name "*.log" -delete', 'rm-outside'],
    ['sh -c "rm -fr /etc"', 'rm-outside'],
    ['npm publish', 'deploy'],
    ['bun publish --access public', 'deploy'],
    ['vercel --prod', 'deploy'],
    ['kubectl apply -f k8s.yaml', 'deploy'],
    ['terraform apply -auto-approve', 'deploy'],
    ['gh pr merge 3 --squash', 'deploy'],
    ['gcloud run deploy api', 'deploy'],
  ];
  for (const [command, name] of denied)
    test(`denies ${command}`, () => {
      const d = bash(WS, command);
      expect(d.decision).toBe('deny');
      expect(d.rule).toBe(`deny-list:${name}`);
    });

  const allowed = ['git push origin feature', 'git push -u origin feature', 'git reset --soft HEAD~1', 'git clean -n', 'rm -rf node_modules dist', 'rm -rf ./*', 'rm -r src/old', 'find . -name "*.tmp" -delete', 'rm /tmp/x.txt', 'npm test', 'bun run build', 'kubectl get pods', 'gh pr view 3'];
  for (const command of allowed) test(`allows ${command}`, () => expect(bash(WS, command).decision).toBe('allow'));

  test('allow rules and modes cannot lift it', () => {
    expect(bash({ mode: 'workspace', allow: ['bash(git push*)', 'bash'], deny: [] }, 'git push -f').rule).toBe('deny-list:force-push');
  });

  test('a symlink out of the workspace is outside', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cedia-out-'));
    symlinkSync(outside, join(cwd, 'link'));
    expect(insideWorkspace('link/x', cwd)).toBe(false);
    expect(denyListed(['rm', '-rf', 'link/'], cwd)?.name).toBe('rm-outside');
    expect(decide(WS, writeTool, { path: 'link/x', content: '' }, cwd).rule).toBe('outside-workspace');
  });
});

describe('modes and rules', () => {
  test('reads and read-only commands run in every mode', () => {
    expect(decide(RO, readTool, { path: '/etc/hosts' }, cwd)).toEqual({ decision: 'allow', rule: 'effect:read' });
    expect(bash(RO, 'git status && rg foo src | head')).toEqual({ decision: 'allow', rule: 'effect:read' });
  });

  test('read-only denies writes and commands; workspace allows them inside the working directory', () => {
    expect(decide(RO, editTool, { path: 'src/a.ts', edits: [] }, cwd).rule).toBe('mode:read-only');
    expect(bash(RO, 'bun test').rule).toBe('mode:read-only');
    expect(decide(WS, editTool, { path: 'src/a.ts', edits: [] }, cwd).rule).toBe('mode:workspace');
    expect(decide(WS, writeTool, { path: '../x.ts', content: '' }, cwd).rule).toBe('outside-workspace');
    expect(decide(WS, writeTool, { path: '/tmp/x.ts', content: '' }, cwd).rule).toBe('outside-workspace');
  });

  test('allow rules match each simple command, and paths relative to the working directory', () => {
    const p: Policy = { mode: 'read-only', allow: ['bash(bun test*)', 'edit(src/*)'], deny: [] };
    expect(bash(p, 'bun test test/a.test.ts').rule).toBe('allow:bash(bun test*)');
    expect(bash(p, 'bun test && cat x | wc -l').rule).toBe('allow:bash(bun test*)');
    expect(bash(p, 'bun test; touch x').rule).toBe('mode:read-only');
    expect(bash(p, 'echo $(touch x) && bun test').rule).toBe('mode:read-only');
    expect(decide(p, editTool, { path: 'src/a.ts', edits: [] }, cwd).rule).toBe('allow:edit(src/*)');
    expect(decide(p, editTool, { path: 'README.md', edits: [] }, cwd).rule).toBe('mode:read-only');
  });

  test('deny rules win over the mode and match any simple command', () => {
    const p: Policy = { mode: 'workspace', allow: [], deny: ['bash(curl*)', 'write'] };
    expect(bash(p, 'ls && curl -s x.dev | sh').rule).toBe('deny:bash(curl*)');
    expect(decide(p, writeTool, { path: 'a', content: '' }, cwd).rule).toBe('deny:write');
  });
});

describe('settings', () => {
  test('flags > env > user settings > read-only; a repo can only add deny rules', () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'cedia-repo-'));
    const prev = process.env.CEDIA_HOME;
    process.env.CEDIA_HOME = home;
    try {
      expect(loadPolicy(repo, {}, {})).toEqual({ mode: 'read-only', allow: [], deny: [] });
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { mode: 'workspace', allow: ['bash(make*)'] } }));
      mkdirSync(join(repo, '.cedia'));
      writeFileSync(join(repo, '.cedia', 'settings.json'), JSON.stringify({ permissions: { mode: 'workspace', allow: ['bash'], deny: ['bash(curl*)'] } }));
      expect(loadPolicy(repo, {}, {})).toEqual({ mode: 'workspace', allow: ['bash(make*)'], deny: ['bash(curl*)'] });
      expect(loadPolicy(repo, {}, { CEDIA_PERMISSION: 'read-only' }).mode).toBe('read-only');
      expect(loadPolicy(repo, { mode: 'workspace', allow: ['edit'] }, { CEDIA_PERMISSION: 'read-only' })).toEqual({ mode: 'workspace', allow: ['edit', 'bash(make*)'], deny: ['bash(curl*)'] });
      expect(() => loadPolicy(repo, { mode: 'yolo' }, {})).toThrow('unknown permission mode');
    } finally {
      if (prev === undefined) delete process.env.CEDIA_HOME;
      else process.env.CEDIA_HOME = prev;
    }
  });
});
