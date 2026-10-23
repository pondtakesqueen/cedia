// Writes src/protocol/protocol.schema.json: JSON Schema for the shapes a client reads or sends, so clients in
// other languages (the desktop's Rust types) are generated from cedia's shapes instead of copied. `--check` exits 1
// when the file on disk differs from what the types say.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGenerator } from 'ts-json-schema-generator';

const root = join(import.meta.dir, '..');
const out = join(root, 'src', 'protocol', 'protocol.schema.json');

// Core -> client messages, client -> core commands, the lines of the session, thread and schedule files, and what
// `cedia --version --json` and `cedia schedules --json` print.
const ROOTS = ['CoreMessage', 'Command', 'SessionEvent', 'ThreadEvent', 'ScheduleEvent', 'Schedule', 'ModelList', 'PermissionList', 'CommandList', 'UsageReport', 'Restored', 'RewindResult', 'DeleteResult', 'McpList', 'McpCheck', 'VersionInfo'] as const;

export function protocolSchema(): string {
  const generator = createGenerator({ path: join(root, 'src', 'protocol', 'index.ts'), tsconfig: join(root, 'tsconfig.json'), skipTypeCheck: true, sortProps: true });
  const definitions: Record<string, unknown> = {};
  for (const type of ROOTS) Object.assign(definitions, generator.createSchema(type).definitions);
  const sorted = Object.fromEntries(Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b)));
  const schema = { $schema: 'http://json-schema.org/draft-07/schema#', roots: Object.fromEntries(ROOTS.map((t) => [t, { $ref: `#/definitions/${t}` }])), definitions: sorted };
  return JSON.stringify(schema, null, 2) + '\n';
}

if (import.meta.main) {
  const schema = protocolSchema();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(out, 'utf8');
    } catch {}
    if (current !== schema) {
      process.stderr.write('src/protocol/protocol.schema.json is stale: run bun scripts/protocol-schema.ts\n');
      process.exit(1);
    }
  } else writeFileSync(out, schema);
}
