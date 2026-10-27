# Blind pairwise review of the same-model runs: each pair (cedia run i vs claude -p run i on one task) is judged
# twice by Opus at medium effort with the A/B order swapped. The A/B mapping stays in this folder, outside the judge's
# working directory. The judge gets read-only tools and no Bash.
import threading, time, json, os, random, re, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
GATEHOME = '/private/tmp/claude-501/-Users-pond-LLM-Projects-aetheria--claude-worktrees-loving-pascal-e4d9d0/2ade9c98-77ee-4f1f-99d6-737525fa0065/scratchpad/gatehome'
CAP = float(os.environ.get('PANEL_CAP', '4.5')); SPENT = [0.0]; LOCK = threading.Lock()
WORK = '/tmp/judge-runs-P25api'
TASKS = ['bugfix-simple', 'feature-simple', 'refactor-rename', 'tb-dedup', 'wide-bug-hunt', 'wide-deprecate', 'wide-three-features', 'hard-csv-stream', 'hard-deny-list', 'hard-edit-tiers', 'hard-injection', 'hard-ledger', 'hard-memo-async', 'hard-pool', 'hard-redact-bugs', 'hard-shell-split', 'hard-sse', 'hard-window', 'real-slop-guard', 'real-subthreads', 'real-threads', 'real-three-changes', 'real-three-delegated', 'long-migrate']
TASKS_DIR = '/tmp/cedia-tui-speed/evals/tasks'
CLAUDE = shutil.which('claude')
random.seed(20261211)

PROMPT = """You are reviewing two candidate changes to the same small codebase, made by two different coding agents for the task in task.md. The starting files are in start/. A.diff and B.diff are unified diffs against start/. Both changes pass the task's visible tests. Read task.md, the starting files and both diffs; do not run anything and change nothing.

Judge each change on five axes, 1 (poor) to 10 (excellent):
- correctness: does it do everything the task and the code's doc comment ask, including edge cases the visible tests do not check?
- quality: readability, structure, naming, fit with the existing code.
- scope: only the changes the task needs, nothing gratuitous; existing tests left intact if the task says so.
- tests: do the tests it adds cover the bugs or behaviour it changed, and would they catch a regression?
- security: 10 if no exploitable input is left in the changed code (a way past a guard or deny rule, injection, path escape, unbounded resource use, a stream or handle left open), no secret leaks into logs, errors or output, and no unsafe call; lower for each such weakness you can tie to a line and a triggering input.

Then pick an overall winner: A, B, or tie (use tie only if you cannot honestly prefer one).

End your reply with exactly one line of JSON and nothing after it:
{"A": {"correctness": n, "quality": n, "scope": n, "tests": n, "security": n}, "B": {"correctness": n, "quality": n, "scope": n, "tests": n, "security": n}, "winner": "A" | "B" | "tie", "why": "<one line>"}"""


def setup(task, i, order, a_side):
    d = f'{WORK}/{task}-{i}-{order}'
    shutil.rmtree(d, ignore_errors=True)
    if os.path.isdir(f'{TASKS_DIR}/{task}') and 'repo' in json.load(open(f'{TASKS_DIR}/{task}/task.json')):
        spec = json.load(open(f'{TASKS_DIR}/{task}/task.json'))
        os.makedirs(f'{d}/start')
        subprocess.run(f"git -C /tmp/cedia-tui-speed archive {spec['repo']['base']} | tar -x -C '{d}/start'", shell=True, check=True)
        prompt = spec['prompt']
    elif os.path.isdir(f'{TASKS_DIR}/{task}'):
        shutil.copytree(f'{TASKS_DIR}/{task}/files', f'{d}/start')
        prompt = json.load(open(f'{TASKS_DIR}/{task}/task.json'))['prompt']
    else:
        spec = json.load(open(f'{TASKS_DIR}/{task}.json'))
        for rel, body in spec['setup'].items():
            os.makedirs(os.path.dirname(f'{d}/start/{rel}'), exist_ok=True)
            open(f'{d}/start/{rel}', 'w').write(body)
        prompt = spec['prompt']
    open(f'{d}/task.md', 'w').write(prompt + '\n')
    b_side = 'claude' if a_side == 'cedia' else 'cedia'
    shutil.copy(f'{HERE}/{a_side}-{task}-{i}.diff', f'{d}/A.diff')
    shutil.copy(f'{HERE}/{b_side}-{task}-{i}.diff', f'{d}/B.diff')
    return d


def judge(job):
    task, i, order, a_side, d = job
    if SPENT[0] >= CAP:
        return dict(task=task, run=i, order=order, a=a_side, error='skipped: panel budget cap reached')
    env = dict(os.environ, CEDIA_HOME=GATEHOME)
    args = ['/tmp/cedia-scope/bin/cedia', '-p', PROMPT, '--model', 'anthropic/claude-sonnet-5-5', '--effort', 'medium', '--permission', 'read-only',
            '--output-format', 'json', '--max-budget-usd', '0.30', '--fallback', 'none', '--spawn', 'off', '--plan', 'none', '--review', 'none', '--cwd', d]
    r = subprocess.run(args, cwd=d, env=env, capture_output=True, text=True, timeout=900)
    try:
        res = json.loads([l for l in r.stdout.strip().splitlines() if l.startswith('{')][-1])
        cost = res.get('costUsd') or 0
        with LOCK: SPENT[0] += cost
        text = res.get('result', '')
        verdict = json.loads(re.findall(r'\{.*\}', text.strip().splitlines()[-1])[-1])
    except Exception as e:
        return dict(task=task, run=i, order=order, a=a_side, error=f'{e}: {r.stdout[-300:]} {r.stderr[-300:]}')
    return dict(task=task, run=i, order=order, a=a_side, verdict=verdict, cost=cost)

jobs = []
mapping = {}
for task in TASKS:
    for i in (1,):
        first = random.choice(['cedia', 'claude'])
        second = 'claude' if first == 'cedia' else 'cedia'
        for order, a_side in ((1, first), (2, second)):
            jobs.append((task, i, order, a_side, setup(task, i, order, a_side)))
            mapping[f'{task}-{i}-{order}'] = a_side
json.dump(mapping, open(f'{HERE}/mapping.json', 'w'), indent=1)

# RESUME: keep good verdicts from an earlier run of this script, judge only the rest
old = {}
if os.path.exists(f'{HERE}/verdicts.json'):
    for v in json.load(open(f'{HERE}/verdicts.json')):
        if 'error' not in v: old[(v['task'], v['run'], v['order'])] = v
todo = [j for j in jobs if (j[0], j[1], j[2]) not in old]
with ThreadPoolExecutor(2) as pool:
    new = list(pool.map(judge, todo))
results = list(old.values()) + new
json.dump(results, open(f'{HERE}/verdicts.json', 'w'), indent=1)
print(sum('error' in r for r in results), 'errors of', len(results), 'panel cost $%.3f' % SPENT[0])
