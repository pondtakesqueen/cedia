# mkjudge.zsh <name> <template dir> <cedia-side jsonl[,jsonl]> <claude-side jsonl[,jsonl]> <python task list> <seed>
S=/private/tmp/claude-501/-Users-pond-LLM-Projects-aetheria--claude-worktrees-loving-pascal-e4d9d0/2ade9c98-77ee-4f1f-99d6-737525fa0065/scratchpad
n=$1; tpl=$2; a=$3; b=$4; tasks=$5; seed=$6; J="$S/judge-$n"; mkdir -p "$J"
python3 - "$J" "$a" "$b" <<'PY'
import json,sys
J,a,b=sys.argv[1:4]
for side,srcs in (('cedia',a),('claude',b)):
    for src in srcs.split(','):
        for l in open(src):
            r=json.loads(l); open(f"{J}/{side}-{r['id']}-{r['run']}.diff",'w').write(r.get('diff') or '')
PY
sed -e "s#WORK = '/tmp/judge-runs2'#WORK = '/tmp/judge-runs-$n'#" -e "s#random.seed(20261024)#random.seed($seed)#" -e "s#ThreadPoolExecutor(3)#ThreadPoolExecutor(2)#" -e "s#^TASKS = \[.*\]#TASKS = $tasks#" "$S/$tpl/judge.py" > "$J/judge.py"
python3 -I "$J/judge.py" > "$J/judge.log" 2>&1
