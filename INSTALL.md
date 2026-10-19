# Install cedia

Requires Node 20+, pi 1.3.0, and a model provider key.

```bash
git clone https://github.com/pongsathonkheereekaew/cedia.git
cd cedia
npm install
./bin/cedia-setup
ln -sf $PWD/bin/cedia ~/.local/bin/cedia
```

Set at least one key:

```bash
export TAVILY_API_KEY="tvly-..."
export ANTHROPIC_API_KEY="sk-ant-..."
```

Run:

```bash
cedia                    # interactive
cedia -p "do X" </dev/null   # headless
```

Update everything (skills, pi packages, pi core):

```bash
cedia-update             # skills + packages only
cedia-update --core      # plus pi core, typecheck, tests
cedia-update --core --smoke  # plus 7-task scoreboard
```
