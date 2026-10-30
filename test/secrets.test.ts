import { expect, test } from 'bun:test';
import { REDACTED, redactSecrets } from '../src/core/safety/secrets.ts';

const r = (s: string) => redactSecrets(s).text;

test('known token formats are replaced wherever they appear', () => {
  const tokens = [
    'sk-ant-api03-' + 'x1'.repeat(20),
    'sk-proj-abc123def456ghi789jkl',
    'ghp_' + 'a1'.repeat(18),
    'github_pat_' + 'B2'.repeat(20),
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-1234567890-abcdef',
    'AIza' + 'c'.repeat(35),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ];
  for (const t of tokens) expect(r(`value ${t} end`)).toBe(`value ${REDACTED} end`);
  expect(redactSecrets(tokens.join('\n')).count).toBe(tokens.length);
});

test('a private key block goes whole, even when the output was cut before its end', () => {
  expect(r('a\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nz')).toBe(`a\n${REDACTED}\nz`);
  expect(r('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA')).toBe(REDACTED);
  const two = '-----BEGIN EC PRIVATE KEY-----\nAAA\n-----END EC PRIVATE KEY-----\nkeep me\n-----BEGIN EC PRIVATE KEY-----\nBBB\n-----END EC PRIVATE KEY-----';
  expect(redactSecrets(two)).toEqual({ text: `${REDACTED}\nkeep me\n${REDACTED}`, count: 2 });
});

test('dotenv, JSON, YAML and URL secrets keep their names', () => {
  expect(r('OPENAI_API_KEY=whatever-it-is\nDEBUG=1\nexport DB_PASSWORD=changeme')).toBe(`OPENAI_API_KEY=${REDACTED}\nDEBUG=1\nexport DB_PASSWORD=${REDACTED}`);
  expect(r('{"api_key": "abcd1234efgh5678", "name": "x"}')).toBe(`{"api_key": "${REDACTED}", "name": "x"}`);
  expect(r('secret = "hunter"')).toBe(`secret = "${REDACTED}"`);
  // A number is a setting under most names, never under a password, secret or key.
  expect(r('DB_PASSWORD=12345678\nPIN_SECRET=998877\nAPI_KEY=123456789012')).toBe(`DB_PASSWORD=${REDACTED}\nPIN_SECRET=${REDACTED}\nAPI_KEY=${REDACTED}`);
  expect(r('DATABASE_URL=postgres://app:s3cr3tpw@db:5432/x')).toBe(`DATABASE_URL=postgres://app:${REDACTED}@db:5432/x`);
});

test('code that only names a secret reads as written', () => {
  for (const line of [
    'password: hashPassword(input),',
    'password: password,',
    'const token = getToken();',
    'const apiKey = process.env.OPENAI_API_KEY',
    'api_key = os.environ["KEY"]',
    'max_tokens: 1000',
    'MAX_TOKENS=4096',
    'tokenizer = "bert-base-uncased"',
    'pip install scikit-learn sk-learn-and-more-words',
    `KEY=${REDACTED}`,
  ])
    expect([line, redactSecrets(line).count]).toEqual([line, 0]);
});

// Cases Claude Code's changelog records missing (2.1.232, 2.1.285, 2.1.286, 2.1.290).
test('secrets hidden by an invisible character, an @ in a URL password, or an auth scheme still go', () => {
  expect(r('API​_KEY=abcd1234efgh5678')).toBe(`API​_KEY=${REDACTED}`);
  expect(r('postgres://app:p@ss@db:5432/x')).toBe(`postgres://app:${REDACTED}@db:5432/x`);
  expect(r('postgres://app:p%40ssword@db:5432/x')).toBe(`postgres://app:${REDACTED}@db:5432/x`);
  expect(r('Authorization: Bearer abcdef123456789xyz')).toBe(`Authorization: Bearer ${REDACTED}`);
  expect(r('-H "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw=="')).toBe(`-H "Authorization: Basic ${REDACTED}"`);
  expect(r('glrt-abcdefghijklmnopqrstu1234 and glpat-abcdefghijklmnop1234.01.abcdefgh12')).toBe(`${REDACTED} and ${REDACTED}`);
  expect(r(`curl -d '{"password":"","token":"abcd1234efgh5678"}'`)).toBe(`curl -d '{"password":"","token":"${REDACTED}"}'`);
  for (const prose of ['Use Bearer authentication for the API.', 'Basic configuration lives in config.ts'])
    expect([prose, redactSecrets(prose).count]).toEqual([prose, 0]);
});

test('long runs of token-like text redact in linear time', () => {
  // Before names were bounded, 160k characters of `a.a.a.` took a minute and `token_token_` ten seconds.
  for (const s of ['a.'.repeat(80_000), 'token_'.repeat(30_000), 'aB3'.repeat(60_000), 'x-'.repeat(80_000)]) {
    const t = performance.now();
    redactSecrets(s);
    expect(performance.now() - t).toBeLessThan(1000);
  }
});

test('a known secret value is redacted wherever it appears, with no name beside it', async () => {
  const { learnSecrets, forgetSecrets, secretsToKnow } = await import('../src/core/safety/secrets.ts');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'cedia-known-'));
  writeFileSync(join(root, '.env'), 'DB_PASSWORD="hunter2hunter2"\nPORT=3000\nNODE_ENV=development\nSTRIPE_WEBHOOK=whsec9a8b7c6d5e4f3a2b1\n# OTHER_TOKEN=commentedout1\n');
  writeFileSync(join(root, '.env.local'), 'export SERVICE_TOKEN=plainletterstoken\n');
  const values = secretsToKnow({ MY_SERVICE_KEY: 'k3y-value-123', HOME: '/root', SHORT_TOKEN: 'abc', TOKEN_PATH: '/etc/token', LANG: 'en_US.UTF-8' }, root);
  expect(values.sort()).toEqual(['hunter2hunter2', 'k3y-value-123', 'plainletterstoken', 'whsec9a8b7c6d5e4f3a2b1'].sort());
  try {
    learnSecrets(values);
    const r = redactSecrets('connecting with hunter2hunter2 on port 3000 (development)\nsig whsec9a8b7c6d5e4f3a2b1, key k3y-value-123 twice: k3y-value-123');
    expect(r.text).toBe(`connecting with ${REDACTED} on port 3000 (development)\nsig ${REDACTED}, key ${REDACTED} twice: ${REDACTED}`);
    expect(r.count).toBe(4);
  } finally {
    forgetSecrets();
  }
  expect(redactSecrets('connecting with hunter2hunter2').count).toBe(0);
});

test('e2e: a dotenv value a command prints with no name never reaches the session log (offline, faux)', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'cedia-known-e2e-'));
  const home = join(dir, '.home');
  Bun.spawnSync(['mkdir', '-p', home]);
  writeFileSync(join(dir, '.env'), 'DB_PASSWORD=s3cretvalue99\n');
  const script = join(home, 'script.json');
  writeFileSync(script, JSON.stringify([{ blocks: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: "printf 'conn %s ok\\n' \"$(cut -d= -f2 .env)\"" } }] }, { blocks: [{ type: 'text', text: 'done' }] }]));
  const bin = join(import.meta.dir, '..', 'bin', 'cedia');
  const p = Bun.spawnSync([bin, '-m', 'faux', '-p', 'go', '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json', '--cwd', dir], { env: { ...process.env, CEDIA_FAUX_SCRIPT: script, CEDIA_HOME: home }, stdin: 'ignore' });
  expect(p.exitCode).toBe(0);
  const logs = (Bun.spawnSync(['find', home, '-name', '*.jsonl']).stdout.toString().trim().split('\n')).filter(Boolean);
  const all = logs.map((f) => readFileSync(f, 'utf8')).join('\n');
  expect(all).toContain(`conn ${REDACTED} ok`);
  expect(all).not.toContain('s3cretvalue99');
});
