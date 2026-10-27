# Where should a writer session hand off? Measured from cedia's own session logs, then replayed at each model's prices.
import json, glob, os, statistics as st
from collections import defaultdict
G = '/private/tmp/claude-501/-Users-pond-LLM-Projects-aetheria--claude-worktrees-loving-pascal-e4d9d0/2ade9c98-77ee-4f1f-99d6-737525fa0065/scratchpad/gatehome'
files = glob.glob(os.path.expanduser('~/.cedia/sessions/*/*.jsonl')) + glob.glob(G + '/sessions/*/*.jsonl')
sess = {}
for f in files:
    R = [json.loads(l) for l in open(f)]
    if R[0].get('role') != 'code': continue
    req = []
    for r in R:
        if r['kind'] == 'assistant' and 'usage' in r:
            u = r['usage']; req.append((u.get('cacheRead', 0), u.get('cacheWrite', 0), u.get('uncached', 0), u.get('output', 0)))
    if req: sess[R[0]['id'] if 'id' in R[0] else f] = dict(model=R[0].get('model'), req=req, path=f, sid=os.path.basename(f)[:-6])
out = []
P = lambda *a: out.append(' '.join(str(x) for x in a))
# 1) peaks and growth per model
P('## 1. Context per writer session, by model\n')
P('| model | sessions | peak p50 | p90 | max | sessions > 60k | tokens added per turn (median) |'); P('|---|---|---|---|---|---|---|')
by = defaultdict(list)
for s in sess.values(): by[s['model']].append(s)
for m, L in sorted(by.items(), key=lambda x: -len(x[1])):
    pk = sorted(max(a + b + c for a, b, c, _ in s['req']) for s in L)
    gr = [st.median([max(0, (q[0] + q[1] + q[2]) - (p[0] + p[1] + p[2])) for p, q in zip(s['req'], s['req'][1:])]) for s in L if len(s['req']) > 3]
    P(f"| {m} | {len(L)} | {pk[len(pk)//2]//1000}k | {pk[int(len(pk)*.9)]//1000}k | {pk[-1]//1000}k | {sum(x > 60000 for x in pk)} | {int(st.median(gr)) if gr else '-'} |")
# 2) measured handoff cost from thread records
P('\n## 2. Handoffs measured\n')
ho = []
for f in glob.glob(os.path.expanduser('~/.cedia/projects/*/threads/*.jsonl')) + glob.glob(G + '/projects/*/threads/*.jsonl'):
    L = [json.loads(l) for l in open(f)]
    for i, r in enumerate(L):
        if r['kind'] == 'handoff':
            nxt = next((x for x in L[i + 1:] if x['kind'] == 'session' and x.get('why') == 'handoff'), None)
            a = sess.get(r['sessionId']) or next((s for s in sess.values() if s['sid'] == r['sessionId']), None)
            b = next((s for s in sess.values() if nxt and s['sid'] == nxt['sessionId']), None)
            if a and b:
                note_out = a['req'][-1][3]; pred_ctx = sum(a['req'][-1][:3])
                s0 = sum(b['req'][0][:3]); w3 = sum(q[1] + q[2] for q in b['req'][:3])
                # turns until first edit in the successor
                Rb = [json.loads(l) for l in open(b['path'])]; t = 0; first_edit = None
                for e in Rb:
                    if e['kind'] == 'assistant': t += 1
                    if e['kind'] == 'tool_intent' and e['tool'] in ('edit', 'write'): first_edit = t; break
                ho.append(dict(model=a['model'], pred_ctx=pred_ctx, note=note_out, s0=s0, w3=w3, edit=first_edit, kind='note'))
for h in ho: P(f"- {h['model']} ({h['kind']}): handed off at {h['pred_ctx']//1000}k; note {h['note']} output tokens; successor's first request {h['s0']//1000}k; writes over its first 3 turns {h['w3']//1000}k; first edit at turn {h['edit']}")
P(f"\nOnly {len(ho)} handoff with both sessions on disk: the eval runs of 2026-10-21/22 that measured handoff at 20k, 30k and 90k kept their logs in temporary homes that are gone, so section 4 uses their result rows instead.")
note = st.median([h['note'] for h in ho]) if ho else 4000
s0 = st.median([h['s0'] for h in ho]) if ho else 10000
extra = max(0, (st.median([h['w3'] for h in ho]) if ho else 30000) - s0)
P(f"\nUsed in the replay: note {int(note)} output tokens, successor start {int(s0)//1000}k, its re-read {int(extra)//1000}k of extra writes over its first turns.")
# 3) replay
PRICES = {  # input, output, cacheRead, cacheWrite (5m), price line, multiplier above it
    'anthropic/claude-haiku-5-5': (0.1, 0.5, 0.01, 0.125, 100_000, 5),
    'anthropic/claude-opus-5-5': (4, 20, 0.2, 5, None, 1),
    'anthropic/claude-sonnet-5-5': (2, 10, 0.1, 2.5, None, 1),
    'anthropic/claude-fable-5-1': (10, 50, 0.25, 12.5, None, 1),
    'deepseek-v4.1-flash': (0.3, 1.2, 0.006, 0.3, None, 1),
}
TH = [60_000, 80_000, 90_000, 100_000, 115_000, 130_000, 150_000, 200_000, 10**9]
long = [s for s in sess.values() if max(sum(q[:3]) for q in s['req']) > 60_000]
def replay(s, th, price):
    inp, outp, rd, wr, line, mul = price
    C = sum(s['req'][0][:3]); prev = 0; cost = 0.0; pending = 0
    deltas = [max(0, sum(q[:3]) - sum(p[:3])) for p, q in zip(s['req'], s['req'][1:])]
    outs = [q[3] for q in s['req']]
    def req(read, write, o, ctx):
        k = mul if line and ctx > line else 1
        return k * (read * rd + write * wr + o * outp) / 1e6
    cost += req(0, C, outs[0], C); prev = C
    for d, o in zip(deltas, outs[1:]):
        if prev > th:  # hand off: the note request reads the context and writes the note; the successor starts small
            cost += req(prev, 0, note, prev)
            C = s0; cost += req(0, s0 + extra, 0, s0 + extra); prev = s0 + extra
        C = prev + d
        cost += req(prev, d, o, C); prev = C
    return cost
P('\n## 3. Replay of the sessions that grew past 60k, at each model\'s prices\n')
counts = ', '.join('%s: %d' % (m, sum(1 for x in long if x['model'] == m)) for m in sorted({x['model'] for x in long}))
P(f"{len(long)} sessions ({counts}). Each one's per-turn growth and output is replayed as it happened, handing off whenever the context passes the threshold. 'none' never hands off.\n")
P('| priced as | ' + ' | '.join('none' if t > 10**8 else f'{t//1000}k' for t in TH) + ' | best | 115k vs best | 150k vs best |')
P('|---|' + '---|' * (len(TH) + 3))
best = {}
for name, price in PRICES.items():
    tot = [sum(replay(s, t, price) for s in long) for t in TH]
    i = min(range(len(TH)), key=lambda j: tot[j]); b = tot[i]
    lab = 'none' if TH[i] > 10**8 else f'{TH[i]//1000}k'; best[name] = (lab, tot)
    P(f"| {name} | " + ' | '.join(f'${x:.2f}' for x in tot) + f" | {lab} | {100*(tot[4]/b-1):+.1f}% | {100*(tot[6]/b-1):+.1f}% |")
print('\n'.join(out))
