import json,sys,collections
# per task per run: outcome from the two orders (cedia/claude/split/tie); a task is steady when its 3 runs agree
for arm in sys.argv[1:]:
    d,name=arm.split(':')
    v=json.load(open(f'{d}/verdicts-{name}.json'))
    per=collections.defaultdict(lambda: collections.defaultdict(list))
    for r in v:
        if 'error' in r: continue
        a=r['a']; w=r['verdict']['winner']; per[r['task']][r['run']].append({'A':a,'B':'claude' if a=='cedia' else 'cedia'}.get(w,'tie'))
    out={}
    for t,runs in per.items():
        res=[]
        for i,ws in runs.items():
            res.append(ws[0] if len(set(ws))==1 else 'split')
        out[t]=res
    steady=sum(1 for t,r in out.items() if len(r)==3 and len(set(r))==1)
    allwin=sum(1 for t,r in out.items() if r.count('cedia')==3)
    print(name,'steady',steady,'/',len(out),'3/3 wins',allwin)
