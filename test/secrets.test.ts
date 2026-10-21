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
});

test('dotenv, JSON, YAML and URL secrets keep their names', () => {
  expect(r('OPENAI_API_KEY=whatever-it-is\nDEBUG=1\nexport DB_PASSWORD=changeme')).toBe(`OPENAI_API_KEY=${REDACTED}\nDEBUG=1\nexport DB_PASSWORD=${REDACTED}`);
  expect(r('{"api_key": "abcd1234efgh5678", "name": "x"}')).toBe(`{"api_key": "${REDACTED}", "name": "x"}`);
  expect(r('secret = "hunter"')).toBe(`secret = "${REDACTED}"`);
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
