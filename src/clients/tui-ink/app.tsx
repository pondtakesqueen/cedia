import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput, useApp, useWindowSize, useStdin, useIsScreenReaderEnabled } from 'ink';
import { VimInput } from './vim-input.tsx';
import Markdown from './markdown.tsx';
import { StatusBar } from './status-bar.tsx';
import { runHeadless } from '../headless/main.ts';
import { decode, type CoreMessage } from '../../protocol/index.ts';
import type { TuiArgs } from '../tui/main.ts';
import type { SessionEvent } from '../../core/types.ts';
import { cediaHome, loadPromptSuggestions } from '../../core/config.ts';
import { fetchMdmSettings } from '../../core/project/mdm-remote.ts';
import { TeamStore } from '../../core/project/teams.ts';
import { voiceInput } from '../../core/project/voice.ts';
import { acceptTrust, isComplete, loadOnboarding } from '../../clients/tui/onboarding.ts';
import { workingDiff } from '../../core/project/git.ts';
import { workspaceSnapshots } from '../../core/safety/snapshot.ts';
import { restoreTurn } from '../../core/project/undo.ts';
import { rewindThread, rewoundText, runLines } from '../../core/project/rewind.ts';
import { forkThread } from '../../core/project/fork.ts';
import { ThreadStore, threadsDir } from '../../core/project/threads.ts';
import { projectKey } from '../../core/session/log.ts';

type Msg = { role: 'user' | 'assistant' | 'tool' | 'system'; text: string; status?: 'running' | 'success' | 'error' };

const colorFor = (role: Msg['role']) =>
  role === 'user' ? 'cyan' : role === 'assistant' ? 'white' : role === 'tool' ? 'gray' : 'yellow';

export function App({ args }: { args: TuiArgs }): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const inputRef = useRef(input);
  const submitRef = useRef<any>(null);
  useEffect(() => { inputRef.current = input; }, [input]);
  const [activity, setActivity] = useState('');
  const [context, setContext] = useState(0);
  const [spent, setSpent] = useState(0);
  const [thread, setThread] = useState<string | undefined>(args.thread);
  const [vimMode, setVimMode] = useState<'insert' | 'normal'>('insert');
  const stopRef = useRef<AbortController | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [picker, setPicker] = useState<{ title: string; items: { value: string; label: string }[]; onPick: (v: string) => void } | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ aMsg: number; aCol: number; bMsg: number; bCol: number } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const store = new ThreadStore(threadsDir(cediaHome(), projectKey(args.cwd)));
  const teamStore = new TeamStore();
  const [teams, setTeams] = useState(teamStore.list());

  const push = (m: Msg) => setMessages((prev) => [...prev, m]);

  const handleCommand = useCallback((line: string) => {
    const [name = '', ...rest] = line.trim().split(/\s+/);
    const say = (t: string) => push({ role: 'system', text: t });
    switch (name) {
      case 'help':
        say('commands: /diff /undo /redo /rewind /fork /new /thread /model /cost /context /status /transcript /search /actions /clear /quit');
        return;
      case 'clear':
        setMessages([]);
        return;
      case 'quit':
      case 'exit':
        exit();
        return;
      case 'cost':
        say(`spent $${spent.toFixed(4)} · context ${context} tokens · rate 0 tok/s`);
        return;
      case 'context':
        say(`context: ${context} tokens${context ? ` (~${Math.round(context / 1000)}k)` : ''}`);
        return;
      case 'status':
        say(`${args.model ?? 'auto'} · ${args.permission ?? 'auto'} · ${thread ?? 'new thread'} · ${running ? 'working' : 'idle'}`);
        return;
      case 'transcript':
        say(messages.map((m) => (m.role === 'user' ? `› ${m.text}` : m.text)).join('\n').slice(0, 4000));
        return;
      case 'search': {
        const term = rest.join(' ').trim().toLowerCase();
        if (!term) { say('/search <term>'); return; }
        const hits = messages.filter((m) => m.text.toLowerCase().includes(term));
        say(hits.length ? hits.map((m) => m.text).join('\n') : 'no matches');
        return;
      }
      case 'actions': {
        say('actions: /copy /rewind /fork /clear');
        return;
      }
      case 'new':
        setThread(undefined);
        say('the next prompt starts a new thread');
        return;
      case 'diff': {
        const d = workingDiff(args.cwd);
        say(d ? [d.patch, ...(d.untracked.length ? ['untracked: ' + d.untracked.join(', ')] : [])].join('\n').slice(0, 4000) : 'no changes');
        return;
      }
      case 'undo': {
        if (!thread) { say('no thread yet'); return; }
        const t = store.read(thread);
        const r = restoreTurn(store, thread, (cwd) => workspaceSnapshots(cwd, cediaHome()), 'undo', { force: rest[0] === 'force' });
        say('undo: ' + JSON.stringify(r).slice(0, 200));
        return;
      }
      case 'redo': {
        if (!thread) { say('no thread yet'); return; }
        const r = restoreTurn(store, thread, (cwd) => workspaceSnapshots(cwd, cediaHome()), 'redo', { force: rest[0] === 'force' });
        say('redo: ' + JSON.stringify(r).slice(0, 200));
        return;
      }
      case 'rewind': {
        if (!thread) { say('no thread yet'); return; }
        const runs = runLines(store.read(thread));
        if (!rest[0]) { say(runs.length ? runs.join('\n') : 'no runs'); return; }
        const n = Number(rest[0]);
        if (!Number.isInteger(n)) { say('/rewind <n>'); return; }
        const r = rewindThread(store, thread, n, { open: (cwd) => workspaceSnapshots(cwd, cediaHome()), sessionFile: (c, sid) => `${c}/${sid}.jsonl` }, { force: rest[1] === 'force' });
        if ('error' in r) { say('error: ' + r.error); return; }
        say(rewoundText(r));
        return;
      }
      case 'fork': {
        if (!thread) { say('no thread yet'); return; }
        const at = rest[0] ?? 'end';
        const side = rest.includes('--side');
        const r = forkThread(store, thread, at, { sessionFile: (cwd, sid) => `${cwd}/${sid}.jsonl` }, { side });
        if ('error' in r) { say('error: ' + r.error); return; }
        setThread(r.thread);
        say(`forked into ${r.thread}`);
        return;
      }
      case 'model': {
        if (rest[0]) {
          say(`model set to ${rest[0]} (takes effect next turn)`);
          return;
        }
        try {
          const { modelList, loadRoles } = require('../../core/providers/models.ts');
          const roles = loadRoles({});
          const ml = modelList(roles.code.ref, process.env as any, undefined);
          const items = ml.models.map((m: any) => ({ value: m.ref, label: `${m.available ? ' ' : '-'} ${m.ref}  ${m.label}` }));
          setPicker({ title: 'models', items, onPick: (v) => { push({ role: "system", text: `model: ${v}` }); } });
        } catch (e) { say('error: ' + (e as Error).message); }
        return;
      }
      case 'permission': {
        if (rest[0]) { say(`permission: ${rest[0]}`); return; }
        const items = [
          { value: 'auto', label: 'auto' },
          { value: 'read-only', label: 'read-only' },
          { value: 'plan', label: 'plan' },
          { value: 'workspace', label: 'workspace' },
        ];
        setPicker({ title: 'permission', items, onPick: (v) => { push({ role: "system", text: `permission: ${v}` }); } });
        return;
      }
      case 'output-style': {
        try {
          const { loadOutputStyles, loadOutputStyleSetting } = require('../../core/output-styles/styles.ts');
          const styles = loadOutputStyles(cediaHome());
          const cur = loadOutputStyleSetting(cediaHome());
          const items = styles.map((s: any) => ({ value: s.name, label: `${s.name === cur ? '*' : ' '} ${s.name}  ${s.description ?? ''}` }));
          setPicker({ title: 'output styles', items, onPick: (v) => { push({ role: "system", text: `output style: ${v}` }); } });
        } catch (e) { say('error: ' + (e as Error).message); }
        return;
      }
      case 'suggest': {
        say('asking for a suggestion…');
        return;
      }
      case 'trust': {
        acceptTrust(cediaHome());
        push({ role: 'system', text: 'trust accepted' });
        return;
      }
      case 'onboarding': {
        const s = loadOnboarding(cediaHome());
        push({ role: 'system', text: `completed: ${s.completed.join(', ') || '(none)'}; trust: ${s.hasTrustDialogAccepted ? 'accepted' : 'pending'}; complete: ${isComplete(cediaHome())}` });
        return;
      }
      case 'thread': {
        if (!rest[0]) {
          const list = store.list().filter((t) => !t.archived).map((t) => `${t.id}  ${t.title}`);
          say(list.length ? list.join('\n') : 'no threads');
          return;
        }
        if (!store.has(rest[0])) { say(`no thread ${rest[0]}`); return; }
        setThread(rest[0]);
        say(`going on with ${rest[0]}`);
        return;
      }
      default:
        say(`unknown command /${name}; /help lists them`);
    }
  }, [args, messages, running, store, thread, exit, spent, context]);

  const submit = useCallback(async (text: string) => {
    if (!text.trim() || running) return;
    if (picker) {
      const n = Number(text.trim());
      const item = Number.isInteger(n) ? picker.items[n - 1] : picker.items.find((i) => i.value === text.trim());
      if (item) { picker.onPick(item.value); }
      else push({ role: 'system', text: 'invalid selection' });
      setPicker(null);
      setInput('');
      return;
    }
    if (text.trim().startsWith('/')) {
      push({ role: 'user', text });
      handleCommand(text.trim().slice(1));
      return;
    }
    setMessages((m) => [...m, { role: 'user', text }]);
    setInput('');
    setRunning(true);
    setActivity('starting');
    let buffer = '';
    const handleChunk = (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const m = decode<CoreMessage>(line);
          if (m.type === 'stream') {
            const e = m.event;
            if (e.type === 'text_delta') {
              setMessages((prev) => {
                const last = prev[prev.length - 1] as Msg | undefined;
                if (last && last.role === 'assistant') {
                  return [...prev.slice(0, -1), { role: 'assistant', text: last.text + e.delta }];
                }
                return [...prev, { role: 'assistant', text: e.delta }];
              });
            } else if (e.type === 'text_start') {
              setActivity('writing');
            } else if (e.type === 'thinking_start') {
              setActivity('thinking');
            }
          } else if (m.type === 'event') {
            const e = m.event as SessionEvent;
            if (e.kind === 'tool_intent') {
              setMessages((prev) => [...prev, { role: 'tool', text: `● ${e.tool} ${String(e.input?.command ?? e.input?.path ?? '').slice(0, 80)}`, status: 'running' }]);
              setActivity(`running ${e.tool}`);
            }
            if (e.kind === 'tool_result') {
              const first = e.output.text.split('\n').find((l) => l.trim()) ?? '';
              const exit = e.output.exitCode !== undefined ? ` exit=${e.output.exitCode}` : '';
              setMessages((prev) => [...prev, { role: 'tool', text: `  ⎿ ${e.output.isError ? 'ERR ' : ''}${first.slice(0, 120)}${exit}`, status: e.output.isError ? 'error' : 'success' }]);
            }
            if (e.kind === 'request') setActivity('waiting for model');
            if (e.kind === 'snapshot' && e.changed.length) setMessages((prev) => [...prev, { role: 'system', text: `changed ${e.changed.join(', ')}` }]);
            if (e.kind === 'permission' && e.decision === 'deny') setMessages((prev) => [...prev, { role: 'system', text: `✗ ${e.tool} denied: ${e.reason ?? ''}` }]);
          }
        } catch {}
      }
    };
    const stop = new AbortController();
    stopRef.current = stop;
    try {
      const result = await runHeadless(
        { ...args, cacheTtl: args.cacheTtl ?? '1h', streamingTools: true, prompt: text, outputFormat: 'stream-json', ...(thread ? { thread } : {}), signal: stop.signal },
        handleChunk,
      );
      setThread(result.thread ?? thread);
      if (typeof result.peakContext === 'number') setContext(result.peakContext);
      setSpent((prev) => prev + (result.costUsd ?? 0));
      setMessages((m) => [...m, { role: 'system', text: `done · ${result.numTurns} turns · $${result.costUsd.toFixed(4)}` }]);
      if (loadPromptSuggestions(args.promptSuggestions)) {
        void (async () => {
          try {
            const { generateSuggestion } = await import('../../core/suggestions/prompt-suggestion.ts');
            const sug = await generateSuggestion({ cwd: args.cwd, model: args.model, lastResult: result.subtype });
            if (sug) setSuggestion(sug.text);
          } catch {}
        })();
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'system', text: `error: ${(e as Error).message}` }]);
    } finally {
      setRunning(false);
      setActivity('');
    }
  }, [args, running, thread, handleCommand]);



  useEffect(() => {
    const stdin = process.stdin;
    try { stdin.setRawMode(true); } catch {}
    const handler = (data: Buffer) => {
      require('fs').appendFileSync('/tmp/manual.log', 'DATA ' + JSON.stringify(data.toString()) + '\n');
      const str = data.toString();
      if (str === '\u0003') { exit(); return; } // Ctrl+C
      if (str.startsWith('\x1b')) return; // escape/mouse
      let cur = inputRef.current;
      let toSubmit: string | null = null;
      for (let i = 0; i < str.length; i++) {
        const ch = str[i] as string;
        if (ch === '\r' || ch === '\n') { toSubmit = cur; cur = ''; }
        else if (ch === '\x7f' || ch === '\b') { cur = cur.slice(0, -1); }
        else if (ch >= ' ') { cur += ch; }
      }
      inputRef.current = cur;
      setInput(cur);
      if (toSubmit !== null && toSubmit.trim()) {
        inputRef.current = '';
        setInput('');
        submitRef.current?.(toSubmit);
      }
    };
    stdin.on('data', handler);
    return () => { stdin.off('data', handler); };
  }, []);
  const { stdin } = useStdin();
  React.useEffect(() => {
    if (process.env.CEDIA_MDM_URL) void fetchMdmSettings().then((d) => { if (Object.keys(d).length) { /* cached by server; reload not needed */ } }).catch(() => {});
    const t = setInterval(() => setTeams(teamStore.list()), 5000);
    return () => clearInterval(t);
  }, []);
  React.useEffect(() => {
    if (!stdin) return;
    const handler = (data: Buffer) => {
      require('fs').appendFileSync('/tmp/manual.log', 'DATA ' + JSON.stringify(data.toString()) + '\n');
      const s = data.toString();
      // wheel
      if (/\x1b\[<64;/.test(s)) setScrollOffset((o) => Math.min(o + 3, Math.max(0, messages.length - 40)));
      if (/\x1b\[<65;/.test(s)) setScrollOffset((o) => Math.max(0, o - 3));
      // left button press: \x1b[<0;COL;ROW M  ; drag (motion): \x1b[<32;COL;ROW M ; release: ...m
      const press = /\x1b\[<0;(\d+);(\d+)M/.exec(s);
      if (press) {
        const col = parseInt(press[1]!, 10);
        const row = parseInt(press[2]!, 10);
        const idx = Math.max(0, Math.min(messages.length - 1, row - 2 + scrollOffset));
        const msg = messages[idx];
        const c = Math.max(0, Math.min((msg?.text.length ?? 1) - 1, col - 1));
        setSelection({ aMsg: idx, aCol: c, bMsg: idx, bCol: c });
        setSelecting(true);
      }
      const drag = /\x1b\[<32;(\d+);(\d+)M/.exec(s);
      if (drag && selecting) {
        const col = parseInt(drag[1]!, 10);
        const row = parseInt(drag[2]!, 10);
        const idx = Math.max(0, Math.min(messages.length - 1, row - 2 + scrollOffset));
        const msg = messages[idx];
        const c = Math.max(0, Math.min((msg?.text.length ?? 1) - 1, col - 1));
        setSelection((sel) => (sel ? { ...sel, bMsg: idx, bCol: c } : null));
      }
      const release = /\x1b\[<0;(\d+);(\d+)m/.exec(s);
      if (release && selecting) {
        setSelecting(false);
        if (selection) {
          const lo = Math.min(selection.aMsg, selection.bMsg);
          const hi = Math.max(selection.aMsg, selection.bMsg);
          const parts: string[] = [];
          for (let i = lo; i <= hi; i++) {
            const m = messages[i];
            if (!m) continue;
            if (lo === hi) {
              const a = Math.min(selection.aCol, selection.bCol);
              const b = Math.max(selection.aCol, selection.bCol) + 1;
              parts.push(m.text.slice(a, b));
            } else if (i === lo) {
              const a = selection.aMsg <= selection.bMsg ? selection.aCol : 0;
              parts.push(m.text.slice(a));
            } else if (i === hi) {
              const b = selection.aMsg <= selection.bMsg ? selection.bCol + 1 : m.text.length;
              parts.push(m.text.slice(0, b));
            } else {
              parts.push(m.text);
            }
          }
          const text = parts.join('\n');
          try {
            const proc = Bun.spawn(['pbcopy'], { stdin: new TextEncoder().encode(text) });
            void proc.exited;
          } catch {}
          push({ role: 'system', text: 'copied selection' });
        }
      }
    };
    stdin.on('data', handler);
    process.stdout.write('\x1b[?1000h\x1b[?1006h');
    return () => {
      stdin.off('data', handler);
      process.stdout.write('\x1b[?1000l\x1b[?1006l');
    };
  }, [stdin, messages.length, selecting, selection, scrollOffset]);

  React.useEffect(() => {
    try {
      const { loadOnboarding, isComplete, ONBOARDING_STEPS } = require('../../clients/tui/onboarding.ts');
      if (!isComplete()) {
        push({ role: 'system', text: `onboarding pending: ${ONBOARDING_STEPS.filter((x: string) => !loadOnboarding().completed.includes(x)).join(', ')}` });
      }
    } catch {}
  }, []);
  const { columns } = useWindowSize();
  const screenReader = useIsScreenReaderEnabled() || process.env.CEDIA_SCREEN_READER === '1';
  const showSidebar = !screenReader && columns >= 120;
  return (
    <Box flexDirection="row" height="100%">
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
          {messages.slice(Math.max(0, messages.length - 40 - scrollOffset), messages.length - scrollOffset || undefined).map((m, i) => {
            const globalIdx = Math.max(0, messages.length - 40 - scrollOffset) + i;
            let a = -1, b = -1;
            if (selection) {
              const lo = Math.min(selection.aMsg, selection.bMsg);
              const hi = Math.max(selection.aMsg, selection.bMsg);
              if (globalIdx >= lo && globalIdx <= hi) {
                if (lo === hi) { a = Math.min(selection.aCol, selection.bCol); b = Math.max(selection.aCol, selection.bCol) + 1; }
                else if (globalIdx === lo) { a = (selection.aMsg <= selection.bMsg ? selection.aCol : 0); b = m.text.length; }
                else if (globalIdx === hi) { a = 0; b = (selection.aMsg <= selection.bMsg ? selection.bCol + 1 : m.text.length); }
                else { a = 0; b = m.text.length; }
              }
            }
            const hasSel = a >= 0 && b > a;
            const prefix = m.role === 'user' ? '› ' : '';
            const full = prefix + m.text;
            const off = prefix.length;
            const sa = hasSel ? a + off : -1;
            const sb = hasSel ? b + off : -1;
            return (
            <Box key={i} flexDirection="column">
              {m.role === 'assistant' ? (
                <Markdown>{m.text}</Markdown>
              ) : hasSel ? (
                <Text wrap="wrap">
                  <Text color={colorFor(m.role)}>{full.slice(0, sa)}</Text>
                  <Text backgroundColor="blue" color="white">{full.slice(sa, sb)}</Text>
                  <Text color={colorFor(m.role)}>{full.slice(sb)}</Text>
                </Text>
              ) : (
                <Text color={colorFor(m.role)} wrap="wrap">{full}</Text>
              )}
            </Box>
            );
          })}
          {running && activity ? (
            <Text color="cyan">{screenReader ? '* ' : ''}{activity}</Text>
          ) : null}
        </Box>
        {picker ? (
          <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
            <Text bold color="cyan">{picker.title}</Text>
            {picker.items.map((it, i) => (
              <Text key={i}>{i + 1}. {it.label}</Text>
            ))}
            <Text dimColor>type a number to select, Esc to cancel</Text>
          </Box>
        ) : null}
        {suggestion ? <Text dimColor>💡 {suggestion} (Tab to accept)</Text> : null}
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color="cyan">› </Text>
          <VimInput value={input} onChange={setInput} onSubmit={submit} vimMode={vimMode} setVimMode={setVimMode} />
        </Box>
        <StatusBar thread={thread} model={args.model} permission={args.permission} running={running} context={context} spend={spent > 0 ? spent : undefined} />
        <Text dimColor>vim:{vimMode}</Text>
      </Box>
      {showSidebar ? (
        <Box flexDirection="column" width={28} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold color="cyan">sidebar</Text>
          <Text dimColor>thread: {thread ?? 'new'}</Text>
          <Text dimColor>model: {args.model ?? 'auto'}</Text>
          <Text dimColor>{running ? 'working' : 'idle'}</Text>
          <Text dimColor>scroll: {scrollOffset}</Text>
          <Text dimColor>msgs: {messages.length}</Text>
          {teams.length ? <Text bold color="cyan">teams</Text> : null}
          {teams.slice(0, 3).map((t) => (
            <Text key={t.id} dimColor>{t.name}: {t.tasks.filter((x) => x.status === 'done').length}/{t.tasks.length}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
