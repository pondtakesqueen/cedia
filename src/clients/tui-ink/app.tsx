import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput, useApp, useWindowSize, useStdin, useIsScreenReaderEnabled } from 'ink';
import { buildAutoItems, highlightSpans, truncateDescription, type AutoItem } from './autocomplete.ts';
import { VimInput } from './vim-input.tsx';
import Markdown from './markdown.tsx';
import { PermissionDialog, permissionDialogFor, toolLabel } from './permission-dialogs.tsx';
import { StatusBar } from './status-bar.tsx';
import { runHeadless } from '../headless/main.ts';

import { runPrompt } from '../../core/loop/run.ts';
import { SessionLog, sessionPath } from '../../core/session/log.ts';
import { providerFor } from '../../core/providers/index.ts';
import { resolveModel } from '../../core/providers/catalog.ts';
import { systemFor } from '../../core/prompts.ts';
import { CORE_TOOLS } from '../../core/tools/index.ts';
import { askedReviewPrompt, fixPrompt, parseVerdict, type ReviewSubject } from '../../core/trust/review.ts';
import { decode, type CoreMessage } from '../../protocol/index.ts';
import type { TuiArgs } from '../tui/main.ts';
import type { SessionEvent } from '../../core/types.ts';
import { cediaHome, loadPromptSuggestions, loadRoles, isMode, loadPolicy, loadPrivacy, readSettings } from '../../core/config.ts';
import { loadTheme } from '../tui/theme.ts';
import { versionInfo } from '../../protocol/version.ts';
import { runStatusLineCommand } from '../tui/statusline.ts';
import { loadKeybindings } from '../tui/keybindings/loader.ts';
import { resolveBindings } from '../tui/keybindings/resolver.ts';
import { matchesKey } from '@mariozechner/pi-tui';
import { fetchMdmSettings } from '../../core/project/mdm-remote.ts';
import { TeamStore } from '../../core/project/teams.ts';
import { voiceInput } from '../../core/project/voice.ts';
import { acceptTrust, isComplete, loadOnboarding, ONBOARDING_STEPS } from '../../clients/tui/onboarding.ts';
import { workingDiff } from '../../core/project/git.ts';
import { MemoryStore, memoryPath } from '../../core/project/memory.ts';
import { loadSkills } from '../../core/skills/skills.ts';
import { listMcp } from '../../core/mcp/manage.ts';
import { threadChanges, commitFiles, prBlocked, currentBranch, defaultBranch, pushAndOpenPr, pullRequest } from '../../core/project/commit.ts';
import { draftCommitMessage } from '../../core/project/draft.ts';
import { workspaceSnapshots } from '../../core/safety/snapshot.ts';
import { restoreTurn } from '../../core/project/undo.ts';
import { rewindThread, rewoundText, runLines } from '../../core/project/rewind.ts';
import { forkThread } from '../../core/project/fork.ts';
import { ThreadStore, threadsDir } from '../../core/project/threads.ts';
import { projectKey } from '../../core/session/log.ts';
import { join } from 'node:path';
import { readFileSync as fsRead, writeFileSync as fsWrite, existsSync as fsExists, readdirSync as fsReaddir, statSync as fsStat } from 'node:fs';
import { usageReport, readEventsLenient, isUsageEvent } from '../../core/session/usage.ts';

type Msg = { role: 'user' | 'assistant' | 'tool' | 'system'; text: string; status?: 'running' | 'success' | 'error' };

const INK_COMMANDS: { name: string; description: string }[] = [
  { name: 'help', description: 'these commands and keys' },
  { name: 'clear', description: 'clear the chat view' },
  { name: 'quit', description: 'leave' },
  { name: 'cost', description: 'spend, context tokens, rate' },
  { name: 'context', description: 'context window usage' },
  { name: 'status', description: 'the status line' },
  { name: 'transcript', description: 'show the full transcript' },
  { name: 'search', description: 'search the chat transcript' },
  { name: 'actions', description: 'message actions menu' },
  { name: 'new', description: 'start a new thread' },
  { name: 'diff', description: 'working tree changes' },
  { name: 'undo', description: 'put back the files the last turn changed' },
  { name: 'redo', description: 'put them forward again' },
  { name: 'rewind', description: 'go back to before a run' },
  { name: 'commit', description: 'commit the files this thread changed' },
  { name: 'pr', description: 'push and open a pull request' },
  { name: 'review', description: 'review the uncommitted changes' },
  { name: 'plan', description: 'send this prompt to the planner first' },
  { name: 'quick', description: 'send this prompt straight to the writer' },
  { name: 'memory', description: 'project memory' },
  { name: 'skills', description: 'skills this session can load' },
  { name: 'mcp', description: 'MCP servers configured' },
  { name: 'fork', description: 'fork a thread' },
  { name: 'thread', description: 'go on with a thread' },
  { name: 'model', description: 'the model the next turn runs on' },
  { name: 'goal', description: 'keep each turn going until a judge finds this holds' },
  { name: 'palette', description: 'command palette' },
  { name: 'settings', description: 'show the current settings' },
  { name: 'config', description: 'show settings.json' },
  { name: 'rename', description: 'rename this thread' },
  { name: 'resume', description: 'go on with a thread' },
  { name: 'branch', description: 'git branches' },
  { name: 'copy', description: 'copy the last reply' },
  { name: 'tasks', description: 'sub-threads / task list' },
  { name: 'agents', description: 'sub-threads of this thread' },
  { name: 'compact', description: 'show handoff/compaction status' },
  { name: 'fast', description: 'toggle fast mode' },
  { name: 'export', description: 'export this thread to a file' },
  { name: 'btw', description: 'ask a side question' },
  { name: 'theme', description: 'the current theme' },
  { name: 'doctor', description: 'versions, settings, MCP, sandbox' },
  { name: 'permission', description: 'permission mode' },
  { name: 'vim', description: 'toggle vim mode' },
  { name: 'hooks', description: 'hooks configured' },
  { name: 'effort', description: 'show or set starting effort' },
  { name: 'output-style', description: 'output style' },
  { name: 'suggest', description: 'suggest a next prompt' },
  { name: 'trust', description: 'accept trust' },
  { name: 'onboarding', description: 'onboarding status' },
  { name: 'statusline', description: 'run a status line command' },
];

const colorFor = (role: Msg['role']) =>
  role === 'user' ? 'cyan' : role === 'assistant' ? 'white' : role === 'tool' ? 'gray' : 'yellow';

export type DialogKind = 'picker' | 'historySearch' | 'messageSelector' | null;

const DIALOG_PRIORITY: Record<NonNullable<DialogKind>, number> = {
  messageSelector: 3,
  picker: 2,
  historySearch: 1,
};

function inkKeyId(input: string, key: any): string | undefined {
  const mods: string[] = [];
  if (key?.shift) mods.push('shift');
  if (key?.ctrl) mods.push('ctrl');
  if (key?.meta || key?.alt) mods.push('alt');
  if (key?.super) mods.push('super');
  let name = '';
  if (key?.upArrow) name = 'up';
  else if (key?.downArrow) name = 'down';
  else if (key?.leftArrow) name = 'left';
  else if (key?.rightArrow) name = 'right';
  else if (key?.pageUp) name = 'pageUp';
  else if (key?.pageDown) name = 'pageDown';
  else if (key?.home) name = 'home';
  else if (key?.end) name = 'end';
  else if (key?.return) name = 'enter';
  else if (key?.escape) name = 'escape';
  else if (key?.tab) name = 'tab';
  else if (key?.backspace) name = 'backspace';
  else if (key?.delete) name = 'delete';
  else if (input === ' ') name = 'space';
  else if (input && input.length === 1) name = input.toLowerCase();
  else if (input) name = input.toLowerCase();
  if (!name) return undefined;
  return mods.length ? `${mods.join('+')}+${name}` : name;
}

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
  const [statusLineOutput, setStatusLineOutput] = useState('');
  const [loadedKeybindings, setLoadedKeybindings] = useState(() => loadKeybindings(cediaHome()));
  const lastCostThresholdRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const [thread, setThread] = useState<string | undefined>(args.thread);
  const [goal, setGoal] = useState<string | undefined>(args.goal);
  const [vimMode, setVimMode] = useState<'insert' | 'normal'>('insert');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'status' | 'config' | 'usage'>('status');
  const [settingsQuery, setSettingsQuery] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // Per-model spend for the Usage tab, from this project's recent session logs.
  // Recomputed when the overlay opens or the tab is selected (not on every keystroke).
  const projectUsage = React.useMemo(() => {
    if (settingsTab !== 'usage') return null;
    try {
      const dir = join(cediaHome(), 'sessions', projectKey(args.cwd));
      if (!fsExists(dir)) return null;
      const files = fsReaddir(dir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ p: join(dir, f), m: fsStat(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m).slice(0, 20);
      if (!files.length) return null;
      const sessions = files.map((f) => ({ id: f.p.split('/').pop()!.replace(/\.jsonl$/, ''), events: readEventsLenient(fsRead(f.p, 'utf8')).filter(isUsageEvent) }));
      const report = usageReport(sessions, {});
      return { models: report.models, sessions: report.sessions };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsTab, settingsOpen]);
  const settingsOpenRef = useRef(settingsOpen);
  useEffect(() => { settingsOpenRef.current = settingsOpen; }, [settingsOpen]);
  const stopRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<{ what: string; yes: (signal: AbortSignal) => Promise<void> | void } | undefined>(undefined);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [transcriptExpanded, setTranscriptExpanded] = useState(true);
  const historyRef = useRef<string[]>([]);
  const [historySearch, setHistorySearch] = useState<{ open: boolean; query: string; selected: number }>({ open: false, query: '', selected: 0 });
  const [messageSelector, setMessageSelector] = useState<{ open: boolean; selected: number }>({ open: false, selected: 0 });
  const [picker, setPicker] = useState<{ title: string; items: { value: string; label: string }[]; onPick: (v: string) => void } | null>(null);
  const [pickerSelected, setPickerSelected] = useState(0);
  const [permissionDialog, setPermissionDialog] = useState<{ tool: string; input?: unknown; reason?: string; rule?: string } | null>(null);
  const toolInputByCallRef = useRef<Record<string, unknown>>({});
  const [focusedDialog, setFocusedDialog] = useState<DialogKind>(null);
  const openDialog = useCallback((kind: NonNullable<DialogKind>) => {
    setFocusedDialog((prev) => {
      if (prev === null || DIALOG_PRIORITY[kind] > DIALOG_PRIORITY[prev]) return kind;
      return prev;
    });
  }, []);
  const closeDialog = useCallback((kind: NonNullable<DialogKind>) => {
    setFocusedDialog((prev) => (prev === kind ? null : prev));
  }, []);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ aMsg: number; aCol: number; bMsg: number; bCol: number } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const store = new ThreadStore(threadsDir(cediaHome(), projectKey(args.cwd)));
  const teamStore = new TeamStore();
  const [teams, setTeams] = useState(teamStore.list());

  const push = (m: Msg) => setMessages((prev) => [...prev, m]);

  // Autocomplete dropdown state (derived during render, never set in an effect —
  // setting picker state from an effect on picker itself caused an update loop).
  const [autoSelected, setAutoSelected] = useState(0);
  const [autoNonce, setAutoNonce] = useState(0);
  const autoDismissedFor = useRef<string | null>(null);
  const skillsList = React.useMemo(() => {
    try { return loadSkills(args.cwd, cediaHome()); } catch { return []; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.cwd]);
  const autoQuery = input.trim().startsWith('/') && !running ? input.trim().slice(1).toLowerCase() : null;
  const autoItems = React.useMemo(() => {
    if (autoQuery === null) return [];
    const cmds: AutoItem[] = INK_COMMANDS.map((c) => ({ value: c.name, name: `/${c.name}`, description: c.description }));
    const skills: AutoItem[] = skillsList.map((s) => ({ value: s.name, name: s.name, description: String(s.description).split('\n')[0] ?? '' }));
    return buildAutoItems(cmds, skills, autoQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoQuery, skillsList]);
  // Reset autocomplete selection whenever the query changes (string dep: no loop).
  useEffect(() => { setAutoSelected(0); autoDismissedFor.current = null; }, [autoQuery]);
  // Read during render so bumping it forces a re-render (used by Tab re-open).
  const autoOpen = autoQuery !== null && autoItems.length > 0
    && !focusedDialog && !settingsOpen && !permissionDialog && !picker
    && autoDismissedFor.current !== input.trim() && autoNonce >= 0;

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
      case 'transcript': {
        const next = !transcriptExpanded;
        setTranscriptExpanded(next);
        push({ role: 'system', text: `transcript ${next ? 'expanded' : 'compact'}` });
        return;
      }
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
      case 'memory': {
        const store = new MemoryStore(memoryPath(cediaHome(), projectKey(args.cwd)));
        const text = rest.join(' ').trim();
        if (!text) {
          const notes = store.notes();
          say(notes.length ? notes.map((n) => `${n.id}  ${n.text}`).join('\\n') : 'no memory notes for this project');
          return;
        }
        try {
          const n = store.add(text, 'tui');
          say(`remembered ${n.id}: ${n.text}`);
        } catch (e) { say((e as Error).message); }
        return;
      }
      case 'skills': {
        const skills = loadSkills(args.cwd, cediaHome());
        say(skills.length ? skills.map((s) => `${s.name}  ${s.description}`).join('\\n') : 'no skills for this project');
        return;
      }
      case 'mcp': {
        const { servers } = listMcp();
        say(servers.length ? servers.map((s) => `${s.name}  ${s.command ?? s.url ?? ''}`).join('\\n') : 'no MCP servers configured');
        return;
      }
      case 'new':
        setThread(undefined);
        say('the next prompt starts a new thread');
        return;
      case 'plan':
      case 'quick': {
        const prompt = rest.join(' ').trim();
        if (!prompt) { say(`/${name} <prompt>`); return; }
        push({ role: 'user', text: line.trim() });
        submit(prompt, name === 'plan' ? 'always' : 'never');
        return;
      }
      case 'diff': {
        const d = workingDiff(args.cwd);
        say(d ? [d.patch, ...(d.untracked.length ? ['untracked: ' + d.untracked.join(', ')] : [])].join('\n').slice(0, 4000) : 'no changes');
        return;
      }
      case 'commit': {
        if (!thread) { say('no thread yet: nothing to commit'); return; }
        const snaps = workspaceSnapshots(args.cwd, cediaHome());
        if (!snaps) { say('no snapshots for this directory, so cedia cannot tell which files the thread changed'); return; }
        const files = threadChanges(store, thread, args.cwd, snaps);
        if (!files.length) { say('nothing this thread changed differs from HEAD'); return; }
        const own = rest.join(' ').trim();
        void (async () => {
          let message = own;
          if (!message) {
            try {
              const writerModel = args.model && !isMode(args.model) ? args.model : loadRoles({}).code.ref;
              const drafted = await draftCommitMessage({ cwd: args.cwd, model: writerModel, files, signal: new AbortController().signal });
              message = drafted.message;
              setSpent((s) => s + drafted.costUsd);
            } catch (e) { say(`git commit failed: ${(e as Error).message}`); return; }
          }
          if (!message) { say('the message came back empty: write one with /commit <message>'); return; }
          say([`commit ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`, '', message, '', 'commit this? y to commit; n, or anything else you type, cancels'].join('\n'));
          pendingRef.current = { what: 'the commit', yes: () => {
            const r = commitFiles(args.cwd, files, message);
            say(r.ok ? (r.out.split('\\n')[0] ?? 'committed') : `git commit failed: ${r.out}`);
          } };
        })();
        return;
      }
      case 'pr': {
        const blocked = prBlocked(args.cwd);
        if (blocked) { say(blocked); return; }
        const branch = currentBranch(args.cwd);
        const base = defaultBranch(args.cwd);
        say(`push ${branch} to origin and open a pull request${base ? ` into ${base}` : ''}? y to go on; n, or anything else you type, cancels`);
        pendingRef.current = { what: 'the push', yes: async (signal) => {
          const r = await pushAndOpenPr(args.cwd, undefined, signal);
          say(r.ok ? r.out : r.out);
        } };
        return;
      }
      case 'review': {
        void (async () => {
          let subject: ReviewSubject;
          let patch: string;
          const prNum = rest[0];
          if (prNum) {
            const got = await pullRequest(args.cwd, prNum.replace(/^#/, ''), undefined, new AbortController().signal);
            if ('error' in got) { say(got.error); return; }
            subject = { kind: 'pr', number: prNum.replace(/^#/, ''), title: got.title, body: got.body };
            patch = got.patch;
          } else {
            const w = workingDiff(args.cwd);
            if (!w) { say('not a git repository'); return; }
            if (!w.patch && !w.untracked.length) { say('no changes to review'); return; }
            subject = { kind: 'changes', untracked: w.untracked };
            patch = w.patch;
          }
          const roles = loadRoles(args.model && !isMode(args.model) ? { code: args.model } : {});
          const model = roles.review?.via === 'cedia' ? roles.review.model : resolveModel(args.model && !isMode(args.model) ? args.model : loadRoles({}).code.ref);
          say(`reviewing ${subject.kind === 'pr' ? `pull request #${(subject as { number: string }).number}` : 'the uncommitted changes'} with ${model.ref}…`);
          const id = crypto.randomUUID();
          const log = SessionLog.create({ id, path: sessionPath(args.cwd, id) });
          log.listeners.push((e) => {
            if (e.kind === 'assistant') for (const b of (e as { blocks?: { type: string; text?: string }[] }).blocks ?? []) if (b.type === 'text' && b.text?.trim()) push({ role: 'assistant', text: (b.text as string) });
            if (e.kind === 'tool_intent' || e.kind === 'tool_result' || e.kind === 'permission') {
              // mirror pi-tui onEvent minimally
              if (e.kind === 'tool_intent') push({ role: 'tool', text: `● ${(e as { tool: string }).tool} running`, status: 'running' });
              if (e.kind === 'tool_result') push({ role: 'tool', text: `  ⎿ ${(e as { output: { text: string } }).output.text.split('\\n')[0]?.slice(0, 120) ?? ''}`, status: (e as { output: { isError?: boolean } }).output.isError ? 'error' : 'success' });
              if (e.kind === 'permission' && (e as { decision: string }).decision === 'deny') {
                setPermissionDialog({ tool: (e as { tool: string }).tool, input: undefined, reason: (e as { reason?: string }).reason, rule: (e as { rule?: string }).rule });
                push({ role: 'system', text: `✗ ${toolLabel((e as { tool: string }).tool)} denied by ${(e as { rule?: string }).rule ?? ''}${(e as { reason?: string }).reason ? `: ${(e as { reason?: string }).reason}` : ''}` });
              }
            }
            // no requestRender in ink; state update triggers render
          });
          const fauxScript = process.env.CEDIA_FAUX_SCRIPT ? JSON.parse(require('node:fs').readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) : undefined;
          const r = await runPrompt(
            {
              log,
              provider: providerFor(model, { fauxScript }),
              model,
              tools: CORE_TOOLS.filter((t) => t.effect !== 'write_workspace'),
              system: systemFor(model),
              cwd: args.cwd,
              role: 'review',
              permission: { ...loadPolicy(args.cwd, { allow: args.allow ?? [], deny: args.deny ?? [], unlock: args.unlock ?? [] }), mode: 'read-only' },
              privacy: loadPrivacy(args.cwd, args.privacy),
              maxTurns: 40,
              signal: new AbortController().signal,
            },
            askedReviewPrompt(subject, patch),
          );
          setSpent((s) => s + r.costUsd);
          say(`review ${r.subtype === 'success' ? 'done' : r.subtype} · ${r.numTurns} turn${r.numTurns === 1 ? '' : 's'} · $${r.costUsd.toFixed(4)}`);
          if (r.subtype !== 'success') { if (r.result.trim()) say(r.result.trim()); return; }
          const { verdict, findings } = parseVerdict(r.result);
          if (verdict !== 'changes' || subject.kind !== 'changes' || !findings) return;
          say(`send these findings to ${thread ? "this thread's writer" : 'a new thread'} to fix? y to send; n, or anything else you type, cancels`);
          pendingRef.current = { what: 'sending the findings', yes: (signal) => submit(fixPrompt(model.ref, findings), undefined) };
        })();
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
        setContext(0);
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
           openDialog('picker');
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
         openDialog('picker');
        return;
      }
      case 'output-style': {
        try {
          const { loadOutputStyles, loadOutputStyleSetting } = require('../../core/output-styles/styles.ts');
          const styles = loadOutputStyles(cediaHome());
          const cur = loadOutputStyleSetting(cediaHome());
          const items = styles.map((s: any) => ({ value: s.name, label: `${s.name === cur ? '*' : ' '} ${s.name}  ${s.description ?? ''}` }));
          setPicker({ title: 'output styles', items, onPick: (v) => { push({ role: "system", text: `output style: ${v}` }); } });
         openDialog('picker');
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
        if (rest[0] === 'accept') { acceptTrust(cediaHome()); push({ role: 'system', text: 'trust accepted' }); return; }
        const s = loadOnboarding(cediaHome());
        push({ role: 'system', text: `completed: ${s.completed.join(', ') || '(none)'}; trust: ${s.hasTrustDialogAccepted ? 'accepted' : 'pending'}; complete: ${isComplete(cediaHome())}` });
        return;
      }
      case 'goal': {
        const condition = rest.join(' ').trim();
        if (!condition) {
          push({ role: 'system', text: goal ? `each turn goes on until a judge finds this holds:\n${goal}` : 'no goal: /goal <condition> sets one' });
          return;
        }
        if (condition === 'off') {
          push({ role: 'system', text: goal ? 'goal ended: a turn is done when the done gate passes' : 'no goal to end' });
          setGoal(undefined);
          return;
        }
        setGoal(condition);
        push({ role: 'system', text: 'from the next turn on, a separate judge checks this after each claim of done, and sends the writer back (at most 3 times) while it does not hold' });
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
      case 'resume': {
        if (!rest[0]) {
          const threads = store.list().filter((t) => !t.archived);
          if (!threads.length) { say('no threads'); return; }
          const items = threads.map((t) => ({ value: t.id, label: `${t.id}  ${t.title}` }));
          setPicker({ title: 'resume', items, onPick: (v) => { setThread(v); push({ role: 'system', text: `going on with ${v}` }); } });
          openDialog('picker');
          return;
        }
        if (!store.has(rest[0])) { say(`no thread ${rest[0]}`); return; }
        setThread(rest[0]); say(`going on with ${rest[0]}`); return;
      }
      case 'rename': {
        const title = rest.join(' ').trim();
        if (!title) { say('/rename <title>'); return; }
        if (!thread) { say('no thread yet'); return; }
        try { const named = store.rename(thread, title); say(`renamed: ${named}`); } catch (e) { say((e as Error).message); }
        return;
      }
      case 'branch': {
        try { const r = Bun.spawnSync(['git', 'branch', '-a'], { cwd: args.cwd }); say(r.stdout.toString().trim() || 'not a git repository or no branches'); } catch (e) { say((e as Error).message); }
        return;
      }
      case 'copy': {
        const last = [...messages].reverse().find((m) => m.role === 'assistant');
        if (!last) { say('nothing to copy'); return; }
        try { const proc = Bun.spawn(['pbcopy'], { stdin: new TextEncoder().encode(last.text) }); void proc.exited; say('copied the last reply'); } catch (e) { say((e as Error).message); }
        return;
      }
      case 'btw': {
        const q = rest.join(' ').trim();
        if (!q) { say('/btw <question>'); return; }
        submit(`By the way, a side question (do not derail the main task): ${q}`);
        return;
      }
      case 'theme': {
        say(`theme: ${loadTheme()}`);
        return;
      }
      case 'settings':
      case 'config': {
        setSettingsTab('status');
        setSettingsQuery('');
        setSettingsOpen(true);
        return;
      }
      case 'hooks': {
        say('hooks: see ~/.cedia/settings.json');
        return;
      }
      case 'effort': {
        const lvl = rest[0];
        if (!lvl) { say('effort: (default)'); return; }
        say(`effort: ${lvl} (set in settings.json)`);
        return;
      }
      case 'compact': {
        say('compaction/handoff runs automatically when context grows long');
        return;
      }
      case 'fast': {
        say('fast mode toggled (settings.json)');
        return;
      }
      case 'export': {
        if (!thread) { say('no thread yet'); return; }
        const t = store.read(thread);
        const path = rest[0] || join(args.cwd, `${thread}.txt`);
        try { const lines = [`thread: ${t.id}`, `title: ${t.title}`, '', ...t.messages.map((m) => `${m.from}: ${m.text}`)]; require('node:fs').writeFileSync(path, lines.join('\\n') + '\\n'); say(`exported to ${path}`); } catch (e) { say((e as Error).message); }
        return;
      }
      case 'tasks':
      case 'agents': {
        if (!thread) { say('no thread yet'); return; }
        const children = store.list().filter((t) => (t as { parent?: string }).parent === thread);
        say(children.length ? children.map((t) => `${t.id}  ${t.title}`).join('\\n') : 'no sub-threads');
        return;
      }
      case 'vim': {
        setVimMode((m) => (m === 'insert' ? 'normal' : 'insert'));
        say(`vim mode: ${vimMode === 'insert' ? 'normal' : 'insert'}`);
        return;
      }
      case 'palette': {
        say('commands: /help lists them; use /<name>');
        return;
      }
      case 'doctor': {
        say(`cedia doctor\\nversion: ${versionInfo().version}\\ncwd: ${args.cwd}\\nmcp: ${listMcp().servers.length}\\nvim: ${vimMode}`);
        return;
      }
      case 'statusline': {
        const cmd = rest.join(' ').trim();
        if (!cmd) { say('usage: /statusline <command>'); return; }
        const out = runStatusLineCommand(cmd, { model: args.model ?? 'auto', workspace: args.cwd, costUsd: spent, contextWindow: context, permissionMode: args.permission, vimMode });
        say(out || '(no output)');
        return;
      }
      default:
        say(`unknown command /${name}; /help lists them`);
    }
  }, [args, messages, running, store, thread, exit, spent, context, goal, transcriptExpanded, openDialog]);

  const submit = useCallback(async (text: string, planWhen?: 'always' | 'never') => {
    if (!text.trim() || running) return;
    if (Date.now() - lastActivityRef.current > 5 * 60 * 1000) {
      push({ role: 'system', text: 'resumed after idle' });
    }
    lastActivityRef.current = Date.now();
    if (picker) {
      const n = Number(text.trim());
      const item = Number.isInteger(n) ? picker.items[n - 1] : picker.items.find((i) => i.value === text.trim());
      if (item) { picker.onPick(item.value); }
      else push({ role: 'system', text: 'invalid selection' });
      setPicker(null);
       closeDialog('picker');
      setInput('');
      return;
    }
    const trimmedText = text.trim();
    if (pendingRef.current) {
      const p = pendingRef.current;
      pendingRef.current = undefined;
      const stop = new AbortController();
      if (/^(y|yes)$/i.test(trimmedText)) { void p.yes(stop.signal); return; }
      push({ role: 'system', text: `not done: ${p.what}` });
      if (/^(n|no)$/i.test(trimmedText)) { setInput(''); return; }
      // anything else falls through as a new prompt/command
    }
    if (trimmedText.startsWith('/')) {
      push({ role: 'user', text });
      handleCommand(trimmedText.slice(1));
      return;
    }
    setMessages((m) => [...m, { role: 'user', text }]);
    setInput('');
    historyRef.current.push(text);
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
              toolInputByCallRef.current[e.callId] = e.input;
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
            if (e.kind === 'permission' && e.decision === 'deny') {
              setPermissionDialog({ tool: e.tool, input: toolInputByCallRef.current[e.callId], reason: e.reason, rule: e.rule });
              setMessages((prev) => [...prev, { role: 'system', text: `✗ ${toolLabel(e.tool)} denied by ${e.rule}${e.reason ? `: ${e.reason}` : ''}` }]);
            }
          }
        } catch {}
      }
    };
    const stop = new AbortController();
    stopRef.current = stop;
    let resultCost = 0;
    try {
      const result = await runHeadless(
        { ...args, cacheTtl: args.cacheTtl ?? '1h', streamingTools: true, prompt: text, outputFormat: 'stream-json', ...(thread ? { thread } : {}), ...(goal ? { goal } : {}), ...(planWhen ? { planWhen } : {}), signal: stop.signal },
        handleChunk,
      );
      setThread(result.thread ?? thread);
      if (typeof result.peakContext === 'number') setContext(result.peakContext);
      resultCost = result.costUsd ?? 0;
      setSpent((prev) => prev + resultCost);
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
      const newSpent = spent + resultCost;
      if (newSpent >= lastCostThresholdRef.current + 1) {
        push({ role: 'system', text: `cost threshold crossed: $${Math.floor(newSpent)}` });
        lastCostThresholdRef.current = Math.floor(newSpent);
      }
      lastActivityRef.current = Date.now();
    }
  }, [args, running, thread, handleCommand, goal, picker, closeDialog]);



  useEffect(() => {
    const stdin = process.stdin;
    try { stdin.setRawMode(true); } catch {}
    const handler = (data: Buffer) => {
      if (settingsOpenRef.current) return;
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
    setLoadedKeybindings(loadKeybindings(cediaHome()));
  }, []);
  React.useEffect(() => {
    if (!stdin) return;
    const handler = (data: Buffer) => {
      require('fs').appendFileSync('/tmp/manual.log', 'DATA ' + JSON.stringify(data.toString()) + '\n');
      const s = data.toString();
      // wheel
      if (/\x1b\[<64;/.test(s)) setScrollOffset((o) => Math.min(o + 3, Math.max(0, messages.length - Math.max(5, rows - 6))));
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
        if (!selection) return;
        if (selection.aMsg === selection.bMsg && selection.aCol === selection.bCol) { setSelection(null); return; }
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
          if (!text) { setSelection(null); return; }
          try {
            const proc = Bun.spawn(['pbcopy'], { stdin: new TextEncoder().encode(text) });
            void proc.exited;
          } catch {}
          push({ role: 'system', text: 'copied selection' });
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
      if (!isComplete()) {
        push({ role: 'system', text: `onboarding pending: ${ONBOARDING_STEPS.filter((x: string) => !loadOnboarding().completed.includes(x)).join(', ')}` });
      }
      if (!loadOnboarding().hasTrustDialogAccepted) {
        push({ role: 'system', text: 'trust dialog: type y to accept, n to decline' });
        pendingRef.current = { what: 'the trust dialog', yes: () => { acceptTrust(cediaHome()); push({ role: 'system', text: 'trust accepted' }); } };
      }
    } catch {}
  }, []);
  React.useEffect(() => {
    let cmd: string | undefined;
    try {
      const raw = JSON.parse(require('node:fs').readFileSync(join(cediaHome(), 'settings.json'), 'utf8')) as { statusLine?: unknown };
      if (typeof raw?.statusLine === 'string') cmd = raw.statusLine;
      else if (raw?.statusLine && typeof (raw.statusLine as { command?: unknown }).command === 'string') cmd = (raw.statusLine as { command: string }).command;
    } catch {}
    if (!cmd) { setStatusLineOutput(''); return; }
    const out = runStatusLineCommand(cmd, { model: args.model ?? 'auto', workspace: args.cwd, costUsd: spent, contextWindow: context, permissionMode: args.permission, vimMode });
    setStatusLineOutput(out);
  }, [spent, context, thread, args.model, args.cwd, args.permission, vimMode]);
  const { columns, rows } = useWindowSize();
  const screenReader = useIsScreenReaderEnabled() || process.env.CEDIA_SCREEN_READER === '1' || process.env.CEDIA_AX_SCREEN_READER === '1';
  const showSidebar = !screenReader && process.env.CEDIA_SIDEBAR === '1';
  const displayMessages = transcriptExpanded ? messages : messages.filter((m) => m.role !== 'tool');
  const windowSize = Math.max(5, rows - 6);
  React.useEffect(() => {
    const max = Math.max(0, displayMessages.length - windowSize);
    setScrollOffset((o) => (o > max ? max : o));
  }, [columns, rows, displayMessages.length]);
  const start = Math.max(0, displayMessages.length - windowSize - scrollOffset);
  const end = displayMessages.length - scrollOffset;
  const renderStart = Math.max(0, start - 5);
  const renderEnd = Math.min(displayMessages.length, end + 5);
  const visibleMessages = displayMessages.slice(renderStart, renderEnd);
  const aboveHidden = renderStart;
  const belowHidden = Math.max(0, displayMessages.length - renderEnd);
  useInput((input, key) => {
    if (permissionDialog) {
      if (key.escape || key.return) { setPermissionDialog(null); return; }
      return;
    }
    if (focusedDialog === 'picker' && picker) {
      if (key.escape) { closeDialog('picker'); setPicker(null); setPickerSelected(0); return; }
      if (key.upArrow) { setPickerSelected((s) => Math.max(0, s - 1)); return; }
      if (key.downArrow) { setPickerSelected((s) => Math.min(picker.items.length - 1, s + 1)); return; }
      if (key.return) {
        const item = picker.items[pickerSelected];
        if (item) { picker.onPick(item.value); }
        closeDialog('picker'); setPicker(null); setPickerSelected(0); setInput('');
        return;
      }
      return;
    }
    // Compact autocomplete dropdown (like cc): ↑/↓ navigate, Enter/Tab accept, Esc dismiss.
    if (autoOpen) {
      const sel = Math.min(autoSelected, autoItems.length - 1);
      if (key.escape) { autoDismissedFor.current = input.trim(); return; }
      if (key.upArrow) { setAutoSelected((s) => Math.max(0, s - 1)); return; }
      if (key.downArrow) { setAutoSelected((s) => Math.min(autoItems.length - 1, s + 1)); return; }
      if (key.return || key.tab) {
        const item = autoItems[sel];
        if (item) { setInput(`/${item.value} `); autoDismissedFor.current = `/${item.value} `; }
        return;
      }
      // Typing filters the list (handled by derivation); other keys fall through.
    }
    // Tab re-opens a dismissed dropdown.
    if (key.tab && !running && input.trim().startsWith('/') && !autoOpen && !focusedDialog && !settingsOpen) {
      autoDismissedFor.current = null;
      setAutoNonce((n) => n + 1);
      return;
    }
    if (key.tab && suggestion) { setInput(suggestion); setSuggestion(null); return; }
    if (settingsOpen) {
      if (key.escape) {
        if (editingKey) { setEditingKey(null); setEditValue(''); return; }
        if (settingsTab === 'config' && settingsQuery) { setSettingsQuery(''); return; }
        setSettingsOpen(false);
        setSettingsQuery('');
        return;
      }
      const tabs: Array<'status' | 'config' | 'usage'> = ['status', 'config', 'usage'];
      if (key.tab || key.rightArrow || key.leftArrow || key.upArrow || key.downArrow) {
        if (key.tab || key.rightArrow || key.downArrow) setSettingsTab((t) => tabs[(tabs.indexOf(t) + 1) % tabs.length]!);
        else setSettingsTab((t) => tabs[(tabs.indexOf(t) - 1 + tabs.length) % tabs.length]!);
        return;
      }
      if (settingsTab === 'config') {
        if (editingKey) {
          if (key.return) {
            try {
              const pp = join(cediaHome(), 'settings.json');
              let raw: Record<string, unknown> = {};
              try { raw = JSON.parse(fsRead(pp, 'utf8')) as Record<string, unknown>; } catch {}
              let v: unknown = editValue;
              try { v = JSON.parse(editValue); } catch { /* keep as string */ }
              raw[editingKey] = v;
              fsWrite(pp, JSON.stringify(raw, null, 2) + '\n');
              push({ role: 'system', text: `setting ${editingKey} updated` });
            } catch (e) { push({ role: 'system', text: `could not save settings: ${(e as Error).message}` }); }
            setEditingKey(null); setEditValue(''); setSettingsQuery('');
            return;
          }
          if (key.backspace || key.delete) { setEditValue((q) => q.slice(0, -1)); return; }
          if (input && !key.ctrl && !key.meta && !key.return && input.length === 1 && input >= ' ') {
            setEditValue((q) => q + input);
            return;
          }
          return;
        }
        if (key.return) {
          try {
            const raw = readSettings(join(cediaHome(), 'settings.json')) as Record<string, unknown>;
            const q = settingsQuery.toLowerCase();
            const keys = Object.keys(raw).filter((k) => !q || k.toLowerCase().includes(q));
            if (keys.length === 1) {
              setEditingKey(keys[0]!);
              setEditValue(JSON.stringify(raw[keys[0]!]) ?? '');
              return;
            }
          } catch { /* fall through */ }
        }
        if (key.backspace || key.delete) { setSettingsQuery((q) => q.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta && !key.return && input.length === 1 && input >= ' ') {
          setSettingsQuery((q) => q + input);
          return;
        }
      }
      return;
    }
    if (key.home) {
      setScrollOffset(Math.max(0, displayMessages.length - windowSize));
      return;
    }
    if (key.end) {
      setScrollOffset(0);
      return;
    }
    if (key.pageUp) {
      setScrollOffset((o) => Math.min(Math.max(0, displayMessages.length - windowSize), o + windowSize));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((o) => Math.max(0, o - windowSize));
      return;
    }
    if (key.escape && !running) {
      setSelection(null);
      setSelecting(false);
    }
    if (!running && !focusedDialog) {
      const id = inkKeyId(input, key);
      // Active context follows the open dialog (specific first, Global always applies).
      const activeContext: string = permissionDialog ? 'Confirmation'
        : settingsOpen ? 'Settings'
        : 'Chat';
      const resolved = resolveBindings(loadedKeybindings).filter(
        (b) => !b.context || b.context === 'Global' || b.context === activeContext,
      );
      for (const b of resolved) {
        const match = (id !== undefined && id === b.key.toLowerCase()) || matchesKey(input, b.key as any);
        if (!match) continue;
        const cmd = b.command;
        if (cmd === 'cancel') {
          setInput('');
          inputRef.current = '';
          return;
        }
        if (cmd === 'submit') {
          const t = inputRef.current;
          if (t.trim()) submit(t);
          return;
        }
        if (cmd === 'historySearch') {
          setHistorySearch({ open: true, query: '', selected: 0 });
          openDialog('historySearch');
          return;
        }
        handleCommand(cmd);
        return;
      }
    }
    if (focusedDialog === 'messageSelector') {
      const runs = thread ? runLines(store.read(thread)) : [];
      if (key.escape) { setMessageSelector({ open: false, selected: 0 });
        closeDialog('messageSelector'); return; }
      if (key.upArrow) { setMessageSelector((m) => ({ ...m, selected: Math.max(0, m.selected - 1) })); return; }
      if (key.downArrow) {
        if (!runs.length) return;
        setMessageSelector((m) => ({ ...m, selected: Math.min(runs.length - 1, m.selected + 1) }));
        return;
      }
      if (key.return) {
        if (!thread) { push({ role: 'system', text: 'no thread yet' }); setMessageSelector({ open: false, selected: 0 });
        closeDialog('messageSelector'); return; }
        const n = messageSelector.selected + 1;
        if (!runs.length) { push({ role: 'system', text: 'no runs to rewind to' }); setMessageSelector({ open: false, selected: 0 });
        closeDialog('messageSelector'); return; }
        const r = rewindThread(store, thread, n, { open: (cwd) => workspaceSnapshots(cwd, cediaHome()), sessionFile: (c, sid) => `${c}/${sid}.jsonl` }, {});
        if ('error' in r) push({ role: 'system', text: 'error: ' + r.error });
        else { push({ role: 'system', text: rewoundText(r) }); setContext(0); }
        setMessageSelector({ open: false, selected: 0 });
        closeDialog('messageSelector');
        return;
      }
      return;
    }
    if (focusedDialog === 'historySearch') {
      if (key.escape) { setHistorySearch({ open: false, query: '', selected: 0 }); closeDialog('historySearch'); return; }
      if (key.upArrow) { setHistorySearch((h) => ({ ...h, selected: Math.max(0, h.selected - 1) })); return; }
      if (key.downArrow) {
        const filtered = historyRef.current.filter((h) => h.toLowerCase().includes(historySearch.query.toLowerCase()));
        if (!filtered.length) return;
        setHistorySearch((h) => ({ ...h, selected: Math.min(filtered.length - 1, h.selected + 1) }));
        return;
      }
      if (key.return) {
        const filtered = historyRef.current.filter((h) => h.toLowerCase().includes(historySearch.query.toLowerCase()));
        const selected = filtered[historySearch.selected];
        setHistorySearch({ open: false, query: '', selected: 0 });
        closeDialog('historySearch');
        if (selected !== undefined) submit(selected);
        return;
      }
      if (key.backspace || key.delete) {
        setHistorySearch((h) => ({ ...h, query: h.query.slice(0, -1), selected: 0 }));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setHistorySearch((h) => ({ ...h, query: h.query + input, selected: 0 }));
        return;
      }
      return;
    }
    if (key.ctrl && (input === 'r' || input === 'R')) {
      setHistorySearch({ open: true, query: '', selected: 0 });
      openDialog('historySearch');
    }
    if (key.ctrl && (input === 'o' || input === 'O')) {
      if (!thread) { push({ role: 'system', text: 'no thread yet' }); return; }
      setMessageSelector({ open: true, selected: 0 });
      openDialog('messageSelector');
    }
  });
  return (
    <Box flexDirection="row" height="100%">
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
          {displayMessages.length === 0 ? (
            <Box flexDirection="column">
              <Text bold={screenReader ? false : true}>cedia {versionInfo().version}</Text>
              <Text dimColor={!screenReader}>{args.model ?? 'auto'} · {args.cwd}</Text>
              <Text dimColor={!screenReader}>/help for commands · Esc stops a turn</Text>
            </Box>
          ) : (
            <>
              {scrollOffset > 0 || aboveHidden > 0 ? <Text dimColor={screenReader ? false : true}>{screenReader ? '' : '↑ '}{aboveHidden} more above</Text> : null}
              {visibleMessages.map((m, i) => {
            const globalIdx = renderStart + i;
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
            if (screenReader) {
              return (
                <Box key={globalIdx} flexDirection="column">
                  <Text wrap="wrap">{m.role}: {m.text}</Text>
                </Box>
              );
            }
            return (
            <Box key={globalIdx} flexDirection="column">
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
                {end < displayMessages.length || belowHidden > 0 ? <Text dimColor={screenReader ? false : true}>{screenReader ? '' : '↓ '}{belowHidden} more below</Text> : null}
              </>
          )}
          {running && activity ? (
            <Text color={screenReader ? undefined : 'cyan'}>{screenReader ? '* ' : ''}{activity}</Text>
          ) : null}
        </Box>
        {focusedDialog === 'picker' && picker ? (
          <Box flexDirection="column" borderStyle={screenReader ? undefined : "single"} borderColor={screenReader ? undefined : "cyan"} paddingX={1}>
            <Text bold={screenReader ? false : true} color={screenReader ? undefined : "cyan"}>{picker.title}</Text>
            {picker.items.map((it, i) => (
              <Text key={i} color={screenReader ? undefined : (i === pickerSelected ? 'cyan' : undefined)} bold={screenReader ? false : (i === pickerSelected)}>{i === pickerSelected ? '› ' : '  '}{i + 1}. {it.label}</Text>
            ))}
            <Text dimColor={!screenReader}>↑/↓ navigate · Enter select · Esc cancel</Text>
          </Box>
        ) : null}
        {focusedDialog === 'historySearch' ? (
          <Box flexDirection="column" borderStyle={screenReader ? undefined : "single"} borderColor={screenReader ? undefined : "cyan"} paddingX={1}>
            <Text bold={screenReader ? false : true} color={screenReader ? undefined : "cyan"}>history search: {historySearch.query || '(type to filter)'}</Text>
            {historyRef.current
              .filter((h) => h.toLowerCase().includes(historySearch.query.toLowerCase()))
              .map((h, i) => (
                <Text key={i} color={screenReader ? undefined : (i === historySearch.selected ? 'black' : undefined)} backgroundColor={screenReader ? undefined : (i === historySearch.selected ? 'cyan' : undefined)}>{h}</Text>
              ))}
            {historyRef.current.filter((h) => h.toLowerCase().includes(historySearch.query.toLowerCase())).length === 0 ? <Text dimColor={!screenReader}>no matches</Text> : null}
            <Text dimColor={!screenReader}>↑↓ navigate · Enter run · Esc close</Text>
          </Box>
        ) : null}
        {focusedDialog === 'messageSelector' ? (
          <Box flexDirection="column" borderStyle={screenReader ? undefined : "single"} borderColor={screenReader ? undefined : "cyan"} paddingX={1}>
            <Text bold={screenReader ? false : true} color={screenReader ? undefined : "cyan"}>message selector (rewind)</Text>
            {!thread ? (
              <Text dimColor={!screenReader}>no thread yet</Text>
            ) : (
              <>
                {runLines(store.read(thread)).map((r, i) => (
                  <Text key={i} color={screenReader ? undefined : (i === messageSelector.selected ? 'black' : undefined)} backgroundColor={screenReader ? undefined : (i === messageSelector.selected ? 'cyan' : undefined)}>{r}</Text>
                ))}
                {runLines(store.read(thread)).length === 0 ? <Text dimColor={!screenReader}>no runs to rewind to</Text> : null}
              </>
            )}
            <Text dimColor={!screenReader}>↑↓ navigate · Enter rewind · Esc close</Text>
          </Box>
        ) : null}
        {permissionDialog ? (
          (() => {
            const Dialog = permissionDialogFor(permissionDialog.tool);
            return <Dialog tool={permissionDialog.tool} input={permissionDialog.input} reason={permissionDialog.reason} rule={permissionDialog.rule} />;
          })()
        ) : null}
        {settingsOpen ? (
          <Box flexDirection="column" borderStyle={screenReader ? undefined : "single"} borderColor={screenReader ? undefined : "cyan"} paddingX={1}>
            <Text bold={screenReader ? false : true} color={screenReader ? undefined : "cyan"}>settings</Text>
            <Box>
              {(['status', 'config', 'usage'] as const).map((t) => (
                <Text key={t} color={screenReader ? undefined : (t === settingsTab ? 'black' : undefined)} backgroundColor={screenReader ? undefined : (t === settingsTab ? 'cyan' : undefined)}> {t} </Text>
              ))}
            </Box>
            {settingsTab === 'status' ? (
              <Box flexDirection="column">
                <Text>model: {args.model ?? 'auto'}</Text>
                <Text>permission: {args.permission ?? 'auto'}</Text>
                <Text>thread: {thread ?? 'new'}</Text>
                <Text>context: {context} tokens</Text>
                <Text>spent: ${spent.toFixed(4)}</Text>
                <Text>vimMode: {vimMode}</Text>
                <Text>running: {running ? 'working' : 'idle'}</Text>
              </Box>
            ) : null}
            {settingsTab === 'config' ? (
              <Box flexDirection="column">
                <Text dimColor={!screenReader}>search: {settingsQuery || '(type to filter)'}</Text>
                {editingKey ? (
                  <Text>edit {editingKey}: {editValue} (Enter saves · Esc cancels)</Text>
                ) : (() => {
                  try {
                    const raw = readSettings(join(cediaHome(), 'settings.json')) as Record<string, unknown>;
                    const q = settingsQuery.toLowerCase();
                    const keys = Object.keys(raw).filter((k) => !q || k.toLowerCase().includes(q));
                    if (!keys.length) return <Text dimColor={!screenReader}>no settings</Text>;
                    return (<>
                      {keys.map((k) => <Text key={k}>{k}: {JSON.stringify(raw[k])}</Text>)}
                      {keys.length === 1 ? <Text dimColor={!screenReader}>Enter edits {keys[0]}</Text> : null}
                    </>);
                  } catch (e) {
                    return <Text dimColor={!screenReader}>no settings</Text>;
                  }
                })()}
              </Box>
            ) : null}
            {settingsTab === 'usage' ? (
              <Box flexDirection="column">
                <Text>spent this session: ${spent.toFixed(4)}</Text>
                <Text>context: {context} tokens</Text>
                {projectUsage ? (
                  <>
                    <Text dimColor={!screenReader}>last {projectUsage.sessions} sessions, by model:</Text>
                    {projectUsage.models.length ? projectUsage.models.map((m) => (
                      <Text key={m.model}>{m.model}: ${m.costUsd.toFixed(4)} · {m.requests} req</Text>
                    )) : <Text dimColor={!screenReader}>no priced requests yet</Text>}
                  </>
                ) : <Text dimColor={!screenReader}>no session logs yet</Text>}
              </Box>
            ) : null}
            <Text dimColor={!screenReader}>Tab/←/→ switch tabs · Esc close</Text>
          </Box>
        ) : null}
        {suggestion ? <Text dimColor={!screenReader}>💡 {suggestion} (Tab to accept)</Text> : null}
        {autoOpen ? (
          <Box flexDirection="column" paddingX={1}>
            {autoItems.slice(0, 7).map((it, i) => {
              const sel = i === Math.min(autoSelected, autoItems.length - 1);
              const maxDesc = Math.max(10, columns - it.name.length - 8);
              const plain = it.name.startsWith('/') ? it.name.slice(1) : it.name;
              return (
                <Text key={`${it.name}::${i}`} wrap="truncate">
                  <Text color={screenReader ? undefined : (sel ? 'cyan' : undefined)}>{sel ? '› ' : '  '}</Text>
                  {it.name.startsWith('/') ? <Text dimColor={!screenReader}>/</Text> : null}
                  {highlightSpans(plain, it.hits).map((sp, si) => (
                    <Text key={si} color={screenReader ? undefined : (sp.hit ? 'cyan' : undefined)} bold={screenReader ? false : sp.hit}>{sp.text}</Text>
                  ))}
                  <Text dimColor={!screenReader}>  {truncateDescription(it.description, maxDesc)}</Text>
                </Text>
              );
            })}
            {autoItems.length > 7 ? <Text dimColor={!screenReader}>  {autoItems.length - 7} more…</Text> : null}
          </Box>
        ) : null}
        <Text dimColor={!screenReader}>{screenReader ? '' : '─'.repeat(Math.max(10, Math.min(columns - 2, 120)))}</Text>
        <Box>
          <Text color={screenReader ? undefined : 'cyan'}>{screenReader ? '' : '› '}</Text>
          <VimInput value={input} onChange={setInput} onSubmit={submit} vimMode={vimMode} setVimMode={setVimMode} />
        </Box>
        <StatusBar thread={thread} model={args.model} permission={args.permission} running={running} context={context} spend={spent > 0 ? spent : undefined} vimMode={vimMode} activity={activity} />
        {statusLineOutput ? <Text dimColor={!screenReader}>{statusLineOutput}</Text> : null}
      </Box>
      {showSidebar ? (
        <Box flexDirection="column" width={28} borderStyle={screenReader ? undefined : "single"} borderColor={screenReader ? undefined : "gray"} paddingX={1}>
          <Text bold={screenReader ? false : true} color={screenReader ? undefined : "cyan"}>sidebar</Text>
          <Text dimColor={!screenReader}>thread: {thread ?? 'new'}</Text>
          <Text dimColor={!screenReader}>model: {args.model ?? 'auto'}</Text>
          <Text dimColor={!screenReader}>{running ? 'working' : 'idle'}</Text>
          <Text dimColor={!screenReader}>scroll: {scrollOffset}</Text>
          <Text dimColor={!screenReader}>msgs: {messages.length}</Text>
          {teams.length ? <Text bold={screenReader ? false : true} color={screenReader ? undefined : "cyan"}>teams</Text> : null}
          {teams.slice(0, 3).map((t) => (
            <Text key={t.id} dimColor={!screenReader}>{t.name}: {t.tasks.filter((x) => x.status === 'done').length}/{t.tasks.length}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
