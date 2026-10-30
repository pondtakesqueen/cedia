# Tally of a panel over several runs: python3 tally.py <dir> <arm> [<dir> ...]. Each (task, run) pair is a win when
# both orders agree, else split or tie.
import json,sys,collections
arm=sys.argv[2]; dirs=[sys.argv[1]]+sys.argv[3:]
per=collections.defaultdict(list); sc={'cedia':collections.Counter(),'claude':collections.Counter()}; n=0
for d in dirs:
    for x in json.load(open(f'{d}/verdicts-{arm}.json')):
        a=x['a']; b='claude' if a=='cedia' else 'cedia'; V=x['verdict']
        w=V['winner']; per[(x['task'],x['run'],d)].append(a if w=='A' else b if w=='B' else 'tie')
        for side,k in ((a,'A'),(b,'B')):
            for c,s in V[k].items(): sc[side][c]+=s
        n+=1
tot=collections.Counter(); bytask=collections.defaultdict(collections.Counter)
for (t,r,d),ws in sorted(per.items()):
    res=ws[0] if len(set(ws))==1 else 'split'; tot[res]+=1; bytask[t][res]+=1
for t,c in sorted(bytask.items()): print(t, dict(c))
print(dict(tot))
for c in ['correctness','quality','scope','tests','security']: print(c, round(sc['cedia'][c]/n,2), round(sc['claude'][c]/n,2))
