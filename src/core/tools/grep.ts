import { isAbsolute, relative, resolve } from 'node:path';
import { clip, MAX_SHELL_OUTPUT_CHARS, type ToolSpec } from './registry.ts';

// Search file contents with ripgrep, which skips what .gitignore and .ignore list (build output, dependencies,
// worktrees), so a question about a large repository does not read gigabytes it never needed: on a 2.8 GB tree a
// writer's `grep -r` took 22 s where rg took 0.16 s. Without rg, `git grep` in a repository, which skips ignored
// files too; elsewhere the tool says to use bash.

const MAX_LINES = 200;
// Files named like credentials (SECRET_NAME in core/project/instructions.ts) are never searched, as read never
// opens them; what a match shows is redacted like any result.
const SECRET_GLOBS = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.netrc', '.npmrc', '.pypirc', 'credentials', 'credentials.json'];
const MAX_COLUMNS = 300;

export const rgPath = () => Bun.which('rg') ?? undefined;

export const grepTool: ToolSpec = {
  name: 'grep',
  description:
    'Search file contents for a regular expression, skipping files .gitignore excludes (fast on large repositories; prefer it to grep -r in bash). Returns path:line:text, or only the paths with files_only. At most 200 lines.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression (Rust regex syntax, as ripgrep takes)' },
      path: { type: 'string', description: 'File or directory to search, absolute or relative to the working directory (default: the working directory)' },
      glob: { type: 'string', description: 'Only files whose path matches this glob, e.g. "*.ts" or "src/**/*.py"' },
      ignore_case: { type: 'boolean', description: 'Match regardless of case' },
      files_only: { type: 'boolean', description: 'List the matching files instead of the lines' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  effect: 'read',
  pathOf: (input) => (typeof input.path === 'string' ? input.path : '.'),
  replay: 'safe',
  async run(input, ctx) {
    const pattern = typeof input.pattern === 'string' ? input.pattern : '';
    if (!pattern) return { text: 'pattern is required', isError: true };
    const where = typeof input.path === 'string' && input.path ? input.path : '.';
    const full = isAbsolute(where) ? where : resolve(ctx.cwd, where);
    const target = relative(ctx.cwd, full) || '.';
    const glob = typeof input.glob === 'string' && input.glob ? input.glob : undefined;
    const icase = input.ignore_case === true;
    const files = input.files_only === true;
    const rg = rgPath();
    let argv: string[];
    if (rg) {
      argv = [rg, '--no-config', '--color', 'never', '--no-heading', '--line-number', '--max-columns', String(MAX_COLUMNS), '--max-columns-preview', '--hidden', '--glob', '!.git', ...SECRET_GLOBS.flatMap((g) => ['--glob', `!${g}`]), ...(icase ? ['-i'] : []), ...(files ? ['-l'] : []), ...(glob ? ['--glob', glob] : []), '-e', pattern, ...(target === '.' ? [] : ['--', target])];
    } else {
      const inRepo = Bun.spawnSync(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: ctx.cwd, stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim() === 'true';
      if (!inRepo) return { text: 'ripgrep (rg) is not installed and this is not a git repository: search with grep in bash', isError: true };
      argv = ['git', '--no-pager', 'grep', '-n', '-I', '--untracked', '-E', ...(icase ? ['-i'] : []), ...(files ? ['-l'] : []), '-e', pattern, '--', glob ? `${target === '.' ? '' : `${target}/`}${glob}` : target, ...SECRET_GLOBS.map((g) => `:(exclude,glob)**/${g}`)];
    }
    const p = Bun.spawn(argv, { cwd: ctx.cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', signal: ctx.signal });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    // rg searches the working directory when given no path, and then prints paths without a leading ./.
    // Both exit 1 when nothing matched.
    if (code === 1 && !out) return { text: `no matches for ${pattern} in ${target}`, isError: false };
    if (code !== 0 && code !== 1) return { text: `grep failed: ${err.trim() || `exit ${code}`}`, isError: true };
    const lines = out.split('\n').filter(Boolean);
    const shown = lines.slice(0, MAX_LINES).join('\n');
    const more = lines.length > MAX_LINES ? `\n[${lines.length - MAX_LINES} more ${files ? 'files' : 'lines'}: narrow the pattern, path or glob]` : '';
    return { text: clip(shown + more, MAX_SHELL_OUTPUT_CHARS), isError: false };
  },
};
