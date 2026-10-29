# Blind pairwise review through the owner's own Claude Code (claude -p, Sonnet, read-only tools), for when API credit is out.
# ARM=<diff prefix> TASKS=a,b python3 -I judge.py, beside <arm>-<task>-1.diff and claude-<task>-1.diff. Each pair is judged
# twice with A/B swapped; a win counts when both orders agree. Run from the repository's root checkout.
import uuid, threading, time, json, os, random, re, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
CAP = 1e9; SPENT = [0.0]; LOCK = threading.Lock()
ARM = os.environ['ARM']
WORK = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'judge-runs-' + ARM)
TASKS = os.environ['TASKS'].split(',')
TASKS_DIR = '/home/user/cedia-code/evals/tasks'
CLAUDE = shutil.which('claude')
random.seed(20261028)

PROMPT = """You are reviewing two candidate changes to the same small codebase, made by two different coding agents for the task in task.md. The starting files are in start/. A.diff and B.diff are unified diffs against start/. Both changes pass the task's visible tests. Read task.md, the starting files and both diffs; do not run anything and change nothing.

Judge each change on five axes, 1 (poor) to 10 (excellent):
- correctness: does it do everything the task and the code's doc comment ask, including edge cases the visible tests do not check?
- quality: readability, structure, naming, fit with the existing code.
- scope: only the changes the task needs, nothing gratuitous; existing tests left intact if the task says so.
- tests: do the tests it adds cover the bugs or behaviour it changed, and would they catch a regression?
- security: 10 if no exploitable input is left in the changed code (a way past a guard or deny rule, injection, path escape, unbounded resource use, a stream or handle left open), no secret leaks into logs, errors or output, and no unsafe call; lower for each such weakness you can tie to a line and a triggering input.

List the concrete defects you found in each change (empty list if none). Then pick an overall winner: A, B, or tie (use tie only if you cannot honestly prefer one).

End your reply with exactly one line of JSON and nothing after it:
{"A": {"correctness": n, "quality": n, "scope": n, "tests": n, "security": n}, "B": {"correctness": n, "quality": n, "scope": n, "tests": n, "security": n}, "winner": "A" | "B" | "tie", "why": "<one line>", "defects_A": ["<short defect, file:line>", ...], "defects_B": [...]}"""


def setup(task, i, order, a_side):
    d = f'{WORK}/{task}-{i}-{order}'
    shutil.rmtree(d, ignore_errors=True)
    if os.path.isdir(f'{TASKS_DIR}/{task}') and 'repo' in json.load(open(f'{TASKS_DIR}/{task}/task.json')):
        spec = json.load(open(f'{TASKS_DIR}/{task}/task.json'))
        os.makedirs(f'{d}/start')
        subprocess.run(f"git -C /home/user/cedia-code archive {spec['repo']['base']} | tar -x -C '{d}/start'", shell=True, check=True)
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
    F={'cedia': ARM, 'claude': 'claude'}
    shutil.copy(f'{HERE}/{F[a_side]}-{task}-{i}.diff', f'{d}/A.diff')
    shutil.copy(f'{HERE}/{F[b_side]}-{task}-{i}.diff', f'{d}/B.diff')
    return d


def judge(job):
    task, i, order, a_side, d = job
    args = [CLAUDE, '-p', PROMPT, '--model', 'sonnet', '--output-format', 'json', '--no-session-persistence',
            '--session-id', str(uuid.uuid4()), '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk']
    r = subprocess.run(args, cwd=d, capture_output=True, text=True, timeout=900, stdin=subprocess.DEVNULL)
    try:
        res = json.loads(r.stdout)
        cost = res.get('total_cost_usd') or 0
        with LOCK: SPENT[0] += cost
        text = res.get('result', '')
        verdict = json.loads(re.findall(r'\{.*\}', text.strip().splitlines()[-1])[-1])
    except Exception as e:
        return dict(task=task, run=i, order=order, a=a_side, error=f'{e}: {r.stdout[-300:]} {r.stderr[-300:]}')
    return dict(task=task, run=i, order=order, a=a_side, verdict=verdict, cost=cost)

jobs = []
mapping = {}
for task in TASKS:
    for i in [int(x) for x in os.environ.get('RUNS', '1').split(',')]:
        first = random.choice(['cedia', 'claude'])
        second = 'claude' if first == 'cedia' else 'cedia'
        for order, a_side in ((1, first), (2, second)):
            jobs.append((task, i, order, a_side, setup(task, i, order, a_side)))
            mapping[f'{task}-{i}-{order}'] = a_side
json.dump(mapping, open(f'{HERE}/mapping-'+ARM+'.json', 'w'), indent=1)

# RESUME: keep good verdicts from an earlier run of this script, judge only the rest
old = {}
if os.path.exists(f'{HERE}/verdicts-'+ARM+'.json'):
    for v in json.load(open(f'{HERE}/verdicts-'+ARM+'.json')):
        if 'error' not in v: old[(v['task'], v['run'], v['order'])] = v
todo = [j for j in jobs if (j[0], j[1], j[2]) not in old]
with ThreadPoolExecutor(2) as pool:
    new = list(pool.map(judge, todo))
results = list(old.values()) + new
json.dump(results, open(f'{HERE}/verdicts-'+ARM+'.json', 'w'), indent=1)
print(sum('error' in r for r in results), 'errors of', len(results), 'panel cost $%.3f' % SPENT[0])
