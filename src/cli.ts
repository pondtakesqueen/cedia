import { parseArgs } from 'node:util';
import { runHeadless } from './clients/headless/main.ts';
import { ALIASES } from './core/providers/catalog.ts';
import { lintSession } from './core/session/lint.ts';
import { SessionLog } from './core/session/log.ts';
import type { Effort } from './core/types.ts';

const USAGE = `usage: cedia -p "<prompt>" [options]   (prompt may also come on stdin)

  -m, --model <ref>            model alias or ref (default: $CEDIA_MODEL or deepseek)
      --output-format <f>      text | json | stream-json (default text)
      --max-turns <n>          stop after n model calls (default 50)
      --max-budget-usd <x>     stop once spend reaches x
      --effort <level>         low | medium | high | xhigh | max
      --cwd <dir>              working directory (default: current)
      --permission <mode>      read-only | workspace (default: $CEDIA_PERMISSION, ~/.cedia/settings.json, read-only)
      --allow <rule>           allow a call, e.g. 'bash(bun test*)' or 'edit(src/*)'; repeatable
      --deny <rule>            deny a call; repeatable. The built-in deny list always applies
      --check <command>        declared check for the done gate, e.g. 'bun test'; repeatable
      --sandbox <s>            auto | on | off: OS sandbox for bash (default: $CEDIA_SANDBOX, settings, auto)
      --allow-domain <host>    let sandboxed commands reach this host; repeatable
      --no-session-file        keep the session log in memory only

       cedia lint-session <file.jsonl>...   check session logs against the trust invariants

models: ${Object.keys(ALIASES).join(', ')}`;

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'lint-session') return lintFiles(argv.slice(1));
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      print: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      'output-format': { type: 'string', default: 'text' },
      'max-turns': { type: 'string' },
      'max-budget-usd': { type: 'string' },
      effort: { type: 'string' },
      cwd: { type: 'string' },
      permission: { type: 'string' },
      allow: { type: 'string', multiple: true },
      deny: { type: 'string', multiple: true },
      check: { type: 'string', multiple: true },
      sandbox: { type: 'string' },
      'allow-domain': { type: 'string', multiple: true },
      'no-session-file': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  let prompt = values.print ?? positionals.join(' ');
  if (!prompt && !process.stdin.isTTY) prompt = (await new Response(Bun.stdin.stream()).text()).trim();
  if (!prompt) {
    console.error(USAGE);
    return 2;
  }
  const format = values['output-format'];
  if (format !== 'text' && format !== 'json' && format !== 'stream-json') {
    console.error(`unknown --output-format ${format}`);
    return 2;
  }
  try {
    const result = await runHeadless({
      prompt,
      model: values.model ?? process.env.CEDIA_MODEL ?? 'deepseek',
      cwd: values.cwd ?? process.cwd(),
      outputFormat: format,
      ...(values['max-turns'] ? { maxTurns: Number(values['max-turns']) } : {}),
      ...(values['max-budget-usd'] ? { maxBudgetUsd: Number(values['max-budget-usd']) } : {}),
      ...(values.effort ? { effort: values.effort as Effort } : {}),
      ...(values['no-session-file'] ? { noSessionFile: true } : {}),
      ...(values.permission ? { permission: values.permission } : {}),
      ...(values.allow ? { allow: values.allow } : {}),
      ...(values.deny ? { deny: values.deny } : {}),
      ...(values.check ? { checks: values.check } : {}),
      ...(values.sandbox ? { sandbox: values.sandbox } : {}),
      ...(values['allow-domain'] ? { allowDomains: values['allow-domain'] } : {}),
    });
    if (result.subtype !== 'success' && format === 'text') console.error(`cedia: ${result.subtype}`);
    return result.subtype === 'success' ? 0 : 1;
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 1;
  }
}

function lintFiles(files: string[]): number {
  if (!files.length) {
    console.error('usage: cedia lint-session <file.jsonl>...');
    return 2;
  }
  let bad = 0;
  for (const file of files) {
    const findings = lintSession(SessionLog.load(file).events);
    for (const f of findings) console.log(`${file}:${f.at + 1}: ${f.rule}: ${f.message}`);
    if (findings.length) bad++;
  }
  return bad ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
