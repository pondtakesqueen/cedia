import { expect, test } from 'bun:test';
import { simpleCommands } from './shell.ts';

test('chains, pipes and background jobs', () => {
  expect(simpleCommands('a x && b | c; d & e || f')).toEqual([['a', 'x'], ['b'], ['c'], ['d'], ['e'], ['f']]);
  expect(simpleCommands('a\nb')).toEqual([['a'], ['b']]);
});

test('substitutions and subshells are commands of their own', () => {
  expect(simpleCommands('echo $(rm -rf /) `id`')).toEqual([['echo'], ['rm', '-rf', '/'], ['id']]);
  expect(simpleCommands('(cd x && make)')).toEqual([['cd', 'x'], ['make']]);
});

test('quotes and escapes', () => {
  expect(simpleCommands(`grep "a b" 'c;d' e\\ f`)).toEqual([['grep', 'a b', 'c;d', 'e f']]);
  expect(simpleCommands(`echo "say \\"hi\\"" ''`)).toEqual([['echo', 'say "hi"', '']]);
  expect(simpleCommands(`echo 'a\\b'`)).toEqual([['echo', 'a\\b']]);
  expect(simpleCommands('echo "open')).toBeNull();
  expect(simpleCommands("echo 'open")).toBeNull();
});

test('redirections are not commands and leave argv', () => {
  expect(simpleCommands('ls 2>&1 > out.txt | grep "a b"')).toEqual([['ls'], ['grep', 'a b']]);
  expect(simpleCommands('cmd >out.txt 2>/dev/null arg')).toEqual([['cmd', 'arg']]);
  expect(simpleCommands('cmd &> log arg')).toEqual([['cmd', 'arg']]);
  expect(simpleCommands('sort < in.txt')).toEqual([['sort']]);
});

test('assignments, keywords and wrappers are unwrapped', () => {
  expect(simpleCommands('sudo -E env A=1 git push -f')).toEqual([['git', 'push', '-f']]);
  expect(simpleCommands('FOO=1 BAR=2 npm publish')).toEqual([['npm', 'publish']]);
  expect(simpleCommands('if true; then rm -r /tmp/x; fi')).toEqual([['true'], ['rm', '-r', '/tmp/x']]);
  expect(simpleCommands('{ rm -rf /; }')).toEqual([['rm', '-rf', '/']]);
  expect(simpleCommands('find . | xargs -0 rm -rf')).toEqual([['find', '.'], ['rm', '-rf']]);
  expect(simpleCommands('nohup time nice -n 5 make')).toEqual([['make']]);
  expect(simpleCommands('timeout -k 2 10s sudo -u root -- git push -f')).toEqual([['git', 'push', '-f']]);
});

test('bash -c and eval are unpacked', () => {
  expect(simpleCommands(`bash -c "git reset --hard && ls"`)).toEqual([['git', 'reset', '--hard'], ['ls']]);
  expect(simpleCommands(`sh -c 'rm -fr /etc'`)).toEqual([['rm', '-fr', '/etc']]);
  expect(simpleCommands('eval git push --force')).toEqual([['git', 'push', '--force']]);
  expect(simpleCommands(`sudo bash -c "cd / && rm -rf *"`)).toEqual([['cd', '/'], ['rm', '-rf', '*']]);
});

test('empty input and empty commands', () => {
  expect(simpleCommands('')).toEqual([]);
  expect(simpleCommands(' ; ; ')).toEqual([]);
  expect(simpleCommands('a;;b')).toEqual([['a'], ['b']]);
});
