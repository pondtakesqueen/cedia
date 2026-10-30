# notx.py <dir> <arm>: pair winners by score sum without the tests dimension (both orders must agree)
import json,collections,sys
d,arm=sys.argv[1:3]
v=json.load(open(f'{d}/verdicts-{arm}.json')); g=collections.defaultdict(list)
for r in v:
    a=r['a']; b='claude' if a=='cedia' else 'cedia'; V=r['verdict']
    s={a:sum(x for k,x in V['A'].items() if k!='tests'), b:sum(x for k,x in V['B'].items() if k!='tests')}
    g[(r['task'],r['run'])].append('cedia' if s['cedia']>s['claude'] else 'claude' if s['claude']>s['cedia'] else 'tie')
print(dict(collections.Counter(w[0] if len(set(w))==1 and w[0]!='tie' else 'split/tie' for w in g.values())))
