import json,sys,collections
d=sys.argv[1]; arm=sys.argv[2]
v=json.load(open(f'{d}/verdicts-{arm}.json'))
per=collections.defaultdict(list); sc={'cedia':collections.Counter(),'claude':collections.Counter()}; n=0
for x in v:
    a=x['a']; b='claude' if a=='cedia' else 'cedia'; V=x['verdict']
    w=V['winner']; per[x['task']].append(a if w=='A' else b if w=='B' else 'tie')
    for side,k in ((a,'A'),(b,'B')):
        for c,s in V[k].items(): sc[side][c]+=s
    n+=1
tot=collections.Counter()
for t,ws in sorted(per.items()):
    r=ws[0] if len(set(ws))==1 else 'split'; tot[r]+=1; print(t,ws,'->',r)
print(dict(tot))
for c in ['correctness','quality','scope','tests','security']: print(c, round(sc['cedia'][c]/n,2), round(sc['claude'][c]/n,2))
