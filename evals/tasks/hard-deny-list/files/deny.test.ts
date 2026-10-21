import { expect, test } from 'bun:test';
import { denyListed } from './deny.ts';

const cwd = '/work/repo';
const hit = (line: string) => denyListed(line.split(' '), cwd)?.name;

test('force-push in all its forms', () => {
  for (const line of ['git push --force origin main', 'git push -f', 'git push -fu origin x', 'git push --force-with-lease', 'git push --force-with-lease=main:abc', 'git push origin +main', 'git push origin :old', 'git push origin --delete old', 'git push -d origin old', 'git push --mirror', 'git push --prune origin', '/usr/bin/git push -f', 'git -C sub push -f', 'git -c user.name=x push --force', 'git --git-dir .git push -f'])
    expect([line, hit(line)]).toEqual([line, 'force-push']);
});

test('ordinary pushes and other git commands pass', () => {
  for (const line of ['git push origin feature', 'git push -u origin feature', 'git push --tags', 'git status', 'git -C f push', 'git log --format=+x', 'git commit -m fix', 'git fetch --prune'])
    expect([line, hit(line)]).toEqual([line, undefined]);
});

test('reset --hard and clean -f', () => {
  expect(hit('git reset --hard HEAD~1')).toBe('reset-hard');
  expect(hit('git reset --soft HEAD~1')).toBeUndefined();
  for (const line of ['git clean -f', 'git clean -fdx', 'git clean -d --force', 'git clean -fn']) expect([line, hit(line)]).toEqual([line, 'clean-force']);
  for (const line of ['git clean -n', 'git clean -f -n', 'git clean -f --dry-run', 'git clean -d']) expect([line, hit(line)]).toEqual([line, undefined]);
});

test('rm -r outside the working directory', () => {
  for (const line of ['rm -rf /', 'rm -rf ~', 'rm -r ../other', 'rm -rf .', 'rm -rf /work/repo', 'rm -R /etc', 'rm --recursive /tmp/x', 'rm -rf $DIR', 'rm -rf ~bob/x', 'rm -rf', 'rm -fr src /etc'])
    expect([line, hit(line)]).toEqual([line, 'rm-outside']);
});

test('rm inside the working directory, or not recursive, passes', () => {
  for (const line of ['rm -rf node_modules dist', 'rm -rf ./*', 'rm -rf *', 'rm -r src/old', 'rm /tmp/x.txt', 'rm -f ../a.txt', 'rm -rf /work/repo/build', '/bin/rm -rf build'])
    expect([line, hit(line)]).toEqual([line, undefined]);
});

test('words after -- are targets', () => {
  expect(hit('rm -rf -- -weird')).toBeUndefined();
  expect(denyListed(['rm', '-rf', '--', '/etc'], cwd)?.name).toBe('rm-outside');
  expect(denyListed(['rm', '--', '-r', '/etc'], cwd)).toBeUndefined(); // -r after -- is a file name, so not recursive
});

test('find -delete and -exec', () => {
  for (const line of ['find / -name x -delete', 'find .. -exec rm {} ;', 'find $HOME -delete', 'find src /var -delete'])
    expect([line, hit(line)]).toEqual([line, 'rm-outside']);
  for (const line of ['find . -name *.tmp -delete', 'find -delete', 'find src -execdir touch {} ;', 'find / -name x'])
    expect([line, hit(line)]).toEqual([line, undefined]);
});

test('empty argv and other commands', () => {
  expect(denyListed([], cwd)).toBeUndefined();
  expect(hit('ls -la')).toBeUndefined();
});
