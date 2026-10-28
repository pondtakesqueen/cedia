import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput, useApp, useWindowSize, useStdin, useIsScreenReaderEnabled } from 'ink';
import { buildAutoItems, highlightSpans, paintRuns, truncateDescription, truncateLongText, estimateLines, offsetAt, loadFrecency, recordPick, frecencyBonus, type AutoItem } from './autocomplete.ts';
import { humanizeSettingKey, settingDisplayValue } from './settings-format.ts';
import { VimInput } from './vim-input.tsx';
import Markdown from './markdown.tsx';
import { inkTheme, type ThemeTokens } from './theme-tokens.ts';
import { PermissionDialog, toolLabel } from './permission-dialogs.tsx';
import { askedBannerText } from './asked.ts';
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
import type { TuiArgs } from './args.ts';
import type { SessionEvent } from '../../core/types.ts';
import { cediaHome, loadPromptSuggestions, loadRoles, isMode, loadPolicy, loadPrivacy, readSettings } from '../../core/config.ts';
import { modelLabel } from '../../core/providers/models.ts';
import { versionInfo } from '../../protocol/version.ts';
import { runStatusLineCommand } from '../tui/statusline.ts';
import { loadKeybindings, watchKeybindings } from './keybindings/loader.ts';
import { activeContext, findCommand, resolveBindings, vimInputGate, type LiveContext } from './keybindings/resolver.ts';
import { ChordInterceptor, chordsFromBindings, matchChord } from './keybindings/chord.ts';
import { cancelStep, messageFullySelected, offsetForIndex, rowMapFromWalk, selectionBounds, type InkSelection, type RowMap, type WalkBand } from './row-map.ts';
import { createHeightCache, heightCacheKey, visibleWindow } from './visible-window.ts';
import { matchesKey } from '@mariozechner/pi-tui';
import { fetchMdmSettings } from '../../core/project/mdm-remote.ts';
import { TeamStore } from '../../core/project/teams.ts';
import { voiceInput } from '../../core/project/voice.ts';
import { acceptTrust, completedNames, isComplete, loadOnboarding, markStep, ONBOARDING_STEPS, reconcileOnboarding, saveOnboarding } from './onboarding.ts';
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
import { readFileSync as fsRead, writeFileSync as fsWrite, existsSync as fsExists, readdirSync as fsReaddir, statSync as fsStat, unlinkSync as fsUnlink } from 'node:fs';
import { tmpdir } from 'node:os';
import { usageReport, readEventsLenient, isUsageEvent } from '../../core/session/usage.ts';

type Msg = { role: 'user' | 'assistant' | 'tool' | 'system'; text: string; status?: 'running' | 'success' | 'error'; dim?: boolean; tone?: 'red' };

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
  { name: 'color', description: 'alias for /theme' },
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

const INPUT_PLACEHOLDERS = [
  'Try "explain how auth works here"',
  'Try "/review the uncommitted changes"',
  'Try "add a test for the parser"',
  'Try "/commit this work"',
  'Try "where is the retry logic?"',
];

const shortCwd = (cwd: string): string => {
  try {
    const home = process.env.HOME ?? '';
    if (home && (cwd === home || cwd.startsWith(home + '/'))) return `~${cwd.slice(home.length)}` || '~';
    return cwd;
  } catch { return cwd; }
};

const themedColorFor = (T: ThemeTokens, role: Msg['role']): string | undefined =>
  role === 'user' ? undefined : role === 'assistant' ? T.text : role === 'tool' ? T.textMuted : T.warning;

function paintedWidth(role: Msg['role'] | undefined, columns: number, screenReader: boolean): number {
  const bar = role === 'user' && !screenReader ? 2 : 0;
  return Math.max(10, columns - 2 - bar);
}

function paintedCol(termCol: number, role: Msg['role'] | undefined, screenReader: boolean): number {
  const bar = role === 'user' && !screenReader ? 2 : 0;
  return Math.max(0, termCol - 1 - bar);
}

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

function normKey(id: string): string {
  const parts = id.toLowerCase().split('+').filter((p) => p.length > 0);
  const name = parts.pop() ?? '';
  parts.sort();
  return parts.length ? `${parts.join('+')}+${name}` : name;
}

export function App({ args }: { args: TuiArgs }): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);
  const [activity, setActivity] = useState('');
  const [context, setContext] = useState(0);
  const [spent, setSpent] = useState(0);
  const [lastRate, setLastRate] = useState(0);
  const [statusLineOutput, setStatusLineOutput] = useState('');
  const [loadedKeybindings, setLoadedKeybindings] = useState(() => loadKeybindings(cediaHome()));
  const lastCostThresholdRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const [thread, setThread] = useState<string | undefined>(args.thread);
  const [permission, setPermission] = useState<string | undefined>(args.permission);
  const permissionRef = useRef(permission);
  permissionRef.current = permission;
  const syncOnboardingRef = useRef<(openTrust?: boolean) => void>(() => {});
  // Theme tokens (opencode-style design tokens, cedia's own values).
  // Bumped when /theme writes, so the whole TUI repaints immediately.
  const [themeTick, setThemeTick] = useState(0);
  const { name: themeName, tokens: T } = React.useMemo(() => inkTheme(cediaHome()), [themeTick]);
  const [model, setModel] = useState<string | undefined>(args.model);
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined>(undefined);
  const [goal, setGoal] = useState<string | undefined>(args.goal);
  const [vimMode, setVimMode] = useState<'insert' | 'normal' | 'visual'>('insert');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'status' | 'config' | 'usage' | 'stats'>('status');
  const [configSelected, setConfigSelected] = useState(0);
  const [settingsQuery, setSettingsQuery] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // Per-model spend for the Usage tab, from this project's recent session logs.
  // Recomputed when the overlay opens or the tab is selected (not on every keystroke).
  const projectUsage = React.useMemo(() => {
    if (settingsTab !== 'usage' && settingsTab !== 'stats') return null;
    try {
      const dir = join(cediaHome(), 'sessions', projectKey(args.cwd));
      if (!fsExists(dir)) return null;
      const files = fsReaddir(dir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ p: join(dir, f), m: fsStat(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m).slice(0, 20);
      if (!files.length) return null;
      const sessions = files.map((f) => ({ id: f.p.split('/').pop()!.replace(/\.jsonl$/, ''), events: readEventsLenient(fsRead(f.p, 'utf8')).filter(isUsageEvent) }));
      const report = usageReport(sessions, {});
      return {
        models: report.models,
        sessions: report.sessions,
        requests: report.requests,
        tokens: { in: report.tokens.input, cache: report.tokens.cacheRead, out: report.tokens.output },
        handoffs: report.handoffs,
      };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsTab, settingsOpen]);
  const projectUsageStats = settingsTab === 'stats' ? projectUsage : null;
  // Effective model for display (status, receipts): explicit choice, else the code role default.
  const effModel = React.useMemo(() => {
    try {
      const ref = model && !isMode(model) ? model : loadRoles({}).code.ref;
      const m = resolveModel(ref);
      return { ref, label: modelLabel(m), provider: m.ref.split('/')[0] ?? m.ref, window: m.caps?.contextWindow };
    } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);
  const stopRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const pendingRef = useRef<{ what: string; yes: (signal: AbortSignal) => Promise<void> | void } | undefined>(undefined);
  const [scrollOffset, setScrollOffset] = useState(0);
  const heightCacheRef = useRef(createHeightCache());
  const loadedKeybindingsRef = useRef(loadedKeybindings);
  loadedKeybindingsRef.current = loadedKeybindings;
  const chordDispatchRef = useRef<(command: string) => void>(() => {});
  const chordRef = useRef(new ChordInterceptor(
    (keys) => matchChord(keys, chordsFromBindings(resolveBindings(loadedKeybindingsRef.current), 'Chat')),
    (command) => chordDispatchRef.current(command),
  ));
  const [transcriptExpanded, setTranscriptExpanded] = useState(true);
  const historyRef = useRef<string[]>([]);
  const histPos = useRef(-1);
  const [historySearch, setHistorySearch] = useState<{ open: boolean; query: string; selected: number }>({ open: false, query: '', selected: 0 });
  const [transcriptSearch, setTranscriptSearch] = useState<{ open: boolean; query: string; selected: number }>({ open: false, query: '', selected: 0 });
  const [messageSelector, setMessageSelector] = useState<{ open: boolean; selected: number }>({ open: false, selected: 0 });
  const [picker, setPicker] = useState<{ title: string; items: { value: string; label: string }[]; onPick: (v: string) => void } | null>(null);
  const [pickerSelected, setPickerSelected] = useState(0);
  const [permissionDialog, setPermissionDialog] = useState<{ tool: string; input?: unknown; reason?: string; rule?: string } | null>(null);
  const toolInputByCallRef = useRef<Record<string, unknown>>({});
  const toolStartByCallRef = useRef<Record<string, number>>({});
  const toolNameByCallRef = useRef<Record<string, string>>({});
  const thinkingRef = useRef('');
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
  const [thinkingText, setThinkingText] = useState('');
  const [showThinking, setShowThinking] = useState(true);
  const [spin, setSpin] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSpin((s) => s + 1), 80);
    return () => clearInterval(t);
  }, [running]);
  const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [selection, setSelection] = useState<InkSelection | null>(null);
  const [selecting, setSelecting] = useState(false);
  const rowMapRef = useRef<RowMap>(rowMapFromWalk([]));
  const displayRef = useRef<Msg[]>([]);
  const columnsRef = useRef(80);
  const screenReaderRef = useRef(false);
  const selectionRef = useRef<InkSelection | null>(null);
  const selectingRef = useRef(false);
  const store = new ThreadStore(threadsDir(cediaHome(), projectKey(args.cwd)));

  const push = (m: Msg) => setMessages((prev) => [...prev, m]);
  const [notice, setNotice] = useState<string | null>(null);
  const keyHintLabels: Record<string, string> = {
    cancel: 'cancel/close', submit: 'send', historyUp: 'older input', historyDown: 'newer input',
    autocomplete: 'complete', historySearch: 'history search',
  };
  // User-customized keybindings (from ~/.cedia/keybindings.json), shown in /help.
  const bindingHints = React.useMemo(() => {
    try {
      const customs = loadKeybindings(cediaHome());
      if (!customs.length) return '';
      const parts: string[] = [];
      for (const b of customs) {
        const label = keyHintLabels[b.command ?? ''] ?? b.command;
        if (label) parts.push(`${b.key} ${label}`);
      }
      return parts.join(' · ');
    } catch { return ''; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKeybindings]);
  // Thread switches always arrive as submitted commands (editor already
  // committed), so just reset per-thread view state. Stable per render.
  const switchThread = useCallback((id: string | undefined) => {
    setThread(id);
    setContext(0);
    setScrollOffset(0);
    setInput('');
    inputRef.current = '';
  }, []);
  const ago = (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };
  const [trustOpen, setTrustOpen] = useState(false);
  const [trustSelected, setTrustSelected] = useState(1);

  // @-file mentions (like cc): file paths from the working tree, fuzzy-matched.
  const [mentionSelected, setMentionSelected] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  // Frecency-ranked autocomplete (opencode-style): picks are recorded per value
  // and boost that item's rank next time. Refreshed after every recorded pick.
  const [frecencyTick, setFrecencyTick] = useState(0);
  const frecencyPath = join(cediaHome(), 'frecency.json');
  const frecencyMap = React.useMemo(() => loadFrecency(frecencyPath), [frecencyTick]);
  const frecencyOf = (value: string) => frecencyBonus(frecencyMap, value);
  const notePick = (value: string) => { try { recordPick(frecencyPath, value); } catch {} setFrecencyTick((t) => t + 1); };

  const fileList = React.useMemo(() => {
    try {
      const glob = new Bun.Glob('**/*');
      const out: string[] = [];
      for (const f of glob.scanSync({ cwd: args.cwd, onlyFiles: true, dot: false }) as Iterable<string>) {
        if (f.startsWith('node_modules/') || f.startsWith('.git/') || f.startsWith('.superpowers/') || f.startsWith('dist/')) continue;
        out.push(f);
        if (out.length >= 300) break;
      }
      return out.sort();
    } catch { return []; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.cwd]);
  const mentionQuery = !running ? (/((?:^|\s)@([\w./-]*))$/.exec(input)?.[2] ?? null) : null;
  const mentionItems = React.useMemo(() => {
    if (mentionQuery === null) return [];
    return buildAutoItems([], fileList.map((f) => ({ value: f, name: f, description: 'file' })), mentionQuery, frecencyOf);
  }, [mentionQuery, fileList, frecencyMap]);
  useEffect(() => { setMentionSelected(0); setMentionDismissed(false); }, [mentionQuery]);
  const mentionOpen = mentionQuery !== null && mentionItems.length > 0
    && !focusedDialog && !settingsOpen && !permissionDialog && !picker && !transcriptSearch.open
    && !mentionDismissed;

  // Autocomplete dropdown state (derived during render, never set in an effect —
  // setting picker state from an effect on picker itself caused an update loop).
  const [autoSelected, setAutoSelected] = useState(0);
  const [autoDismissed, setAutoDismissed] = useState(false);
  const skillsList = React.useMemo(() => {
    try { return loadSkills(args.cwd, cediaHome()); } catch { return []; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.cwd]);
  const autoQuery = input.trim().startsWith('/') && !running ? input.trim().slice(1).toLowerCase() : null;
  const autoItems = React.useMemo(() => {
    if (autoQuery === null) return [];
    const cmds: AutoItem[] = INK_COMMANDS.map((c) => ({ value: c.name, name: `/${c.name}`, description: c.description }));
    const skills: AutoItem[] = skillsList.map((s) => ({ value: s.name, name: s.name, description: String(s.description).split('\n')[0] ?? '' }));
    return buildAutoItems(cmds, skills, autoQuery, frecencyOf);
  }, [autoQuery, skillsList, frecencyMap]);
  // Reset autocomplete selection whenever the query changes (string dep: no loop).
  useEffect(() => { setAutoSelected(0); setAutoDismissed(false); }, [autoQuery]);
  useEffect(() => { setConfigSelected(0); }, [settingsQuery, settingsTab]);
  // Read during render so bumping it forces a re-render (used by Tab re-open).
  const autoOpen = autoQuery !== null && mentionQuery === null && autoItems.length > 0
    && !focusedDialog && !settingsOpen && !permissionDialog && !picker && !transcriptSearch.open
    && !autoDismissed;

  const handleCommand = useCallback((line: string) => {
    const [name = '', ...rest] = line.trim().split(/\s+/);
    const say = (t: string, tone?: 'red') => push({ role: 'system', text: t, ...(tone ? { tone } : {}) });
    switch (name) {
      case 'help': {
        const groups: [string, string[]][] = [
          ['thread', ['/new', '/thread', '/resume', '/rename', '/fork', '/rewind', '/undo', '/redo', '/diff']],
          ['run', ['/plan', '/quick', '/model', '/goal', '/effort', '/permission']],
          ['project', ['/commit', '/pr', '/review', '/memory', '/skills', '/mcp']],
          ['view', ['/clear', '/transcript', '/search', '/settings', '/doctor', '/theme', '/palette', '/actions', '/copy', '/export', '/compact', '/tasks', '/agents', '/branch', '/status', '/cost', '/context']],
          ['other', ['/help', '/quit', '/vim', '/hooks', '/btw', '/suggest', '/trust', '/onboarding', '/statusline', '/output-style', '/config']],
        ];
        const byName = new Map(INK_COMMANDS.map((c) => [c.name, c.description]));
        say(groups.map(([g, names]) => `${g}: ${names.map((n) => `${n} — ${byName.get(n.slice(1)) ?? ''}`).join(' · ')}`).join('\n'));
        say('keys: Esc stops a turn · Ctrl+C cancels/quits · Ctrl+R history · Ctrl+O rewind · Ctrl+F search · Ctrl+G external editor · Tab completes · Shift+Tab permission · Meta+P model · Meta+O fast · Meta+T thinking · ↑↓ navigate · PgUp/PgDn scroll · type / for commands · @ for files · \\+Enter newline' + (bindingHints ? ` · custom keys: ${bindingHints}` : ''));
        return;
      }
      case 'historyUp':
      case 'historySearchUp': {
        const h = historyRef.current;
        if (!h.length) return;
        const p = histPos.current === -1 ? h.length - 1 : Math.max(0, histPos.current - 1);
        histPos.current = p;
        setInput(h[p] ?? '');
        return;
      }
      case 'historyDown':
      case 'historySearchDown': {
        const h = historyRef.current;
        if (histPos.current === -1) return;
        const p = histPos.current + 1;
        if (p >= h.length) { histPos.current = -1; setInput(''); }
        else { histPos.current = p; setInput(h[p] ?? ''); }
        return;
      }
      case 'clear':
        setMessages([]);
        return;
      case 'quit':
      case 'exit':
        exit();
        return;
      case 'cost':
        say(`spent $${spent.toFixed(4)} · context ${context} tokens · rate ${lastRate > 0 ? `${Math.round(lastRate)} tok/s` : '—'}`);
        return;
      case 'context':
        say(`context: ${context} tokens${context ? ` (~${Math.round(context / 1000)}k)` : ''}`);
        return;
      case 'status':
        say(`${model ?? 'auto'} · ${permission ?? 'auto'} · ${thread ?? 'new thread'} · ${running ? 'working' : 'idle'}`);
        return;
      case 'transcript': {
        const next = !transcriptExpanded;
        setTranscriptExpanded(next);
        push({ role: 'system', text: `transcript ${next ? 'expanded' : 'compact'}` });
        return;
      }
      case 'search': {
        const term = rest.join(' ').trim();
        setTranscriptSearch({ open: true, query: term, selected: 0 });
        return;
      }
      case 'actions': {
        const items = [
          { value: 'copy', label: 'copy — copy the last reply' },
          { value: 'rewind', label: 'rewind — go back to before a run' },
          { value: 'fork', label: 'fork — fork this thread' },
          { value: 'clear', label: 'clear — clear the chat view' },
        ];
        setPicker({ title: 'message actions', items, onPick: (v) => { setInput(''); inputRef.current = ''; handleCommand(v); } });
        openDialog('picker');
        setPickerSelected(0);
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
        switchThread(undefined);
        say('the next prompt starts a new thread');
        return;
      case 'plan':
      case 'quick': {
        const prompt = rest.join(' ').trim();
        if (!prompt) { say(`/${name} <prompt>`); return; }
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
        busyRef.current = true;
        void (async () => {
          try {
          let message = own;
          if (!message) {
            try {
              const writerModel = model && !isMode(model) ? model : loadRoles({}).code.ref;
              const drafted = await draftCommitMessage({ cwd: args.cwd, model: writerModel, files, signal: new AbortController().signal });
              message = drafted.message;
              setSpent((s) => s + drafted.costUsd);
            } catch (e) { say(`git commit failed: ${(e as Error).message}`, 'red'); return; }
          }
          if (!message) { say('the message came back empty: write one with /commit <message>'); return; }
          say([`commit ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`, '', message, '', 'commit this? y to commit; n, or anything else you type, cancels'].join('\n'));
          pendingRef.current = { what: 'the commit', yes: () => {
            const r = commitFiles(args.cwd, files, message);
            say(r.ok ? (r.out.split('\\n')[0] ?? 'committed') : `git commit failed: ${r.out}`, r.ok ? undefined : 'red');
          } };
          } finally { busyRef.current = false; }
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
          busyRef.current = true;
          try {
            const r = await pushAndOpenPr(args.cwd, undefined, signal);
            say(r.ok ? r.out : r.out, r.ok ? undefined : 'red');
          } finally { busyRef.current = false; }
        } };
        return;
      }
      case 'review': {
        busyRef.current = true;
        void (async () => {
          try {
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
          const roles = loadRoles(model && !isMode(model) ? { code: model } : {});
          const reviewModel = roles.review?.via === 'cedia' ? roles.review.model : resolveModel(model && !isMode(model) ? model : loadRoles({}).code.ref);
          say(`reviewing ${subject.kind === 'pr' ? `pull request #${(subject as { number: string }).number}` : 'the uncommitted changes'} with ${reviewModel.ref}…`);
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
              provider: providerFor(reviewModel, { fauxScript }),
              model: reviewModel,
              tools: CORE_TOOLS.filter((t) => t.effect !== 'write_workspace'),
              system: systemFor(reviewModel),
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
          if (r.subtype !== 'success') { if (r.result.trim()) say(r.result.trim(), 'red'); return; }
          const { verdict, findings } = parseVerdict(r.result);
          if (verdict !== 'changes' || subject.kind !== 'changes' || !findings) return;
          say(`send these findings to ${thread ? "this thread's writer" : 'a new thread'} to fix? y to send; n, or anything else you type, cancels`);
          pendingRef.current = { what: 'sending the findings', yes: (signal) => submit(fixPrompt(reviewModel.ref, findings), undefined) };
          } finally { busyRef.current = false; }
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
        switchThread(r.thread);
        say(`forked into ${r.thread}`);
        return;
      }
      case 'model': {
        if (rest[0]) {
          if (isMode(rest[0])) { say(`${rest[0]} is a mode, not a model: pick a model ref from /model`, 'red'); return; }
          try { resolveModel(rest[0]); } catch { say(`unknown model: ${rest[0]} (see /model for choices)`, 'red'); return; }
          setModel(rest[0]);
          say(`the next turn runs on ${rest[0]}`);
          return;
        }
        try {
          const { modelList, loadRoles } = require('../../core/providers/models.ts');
          const roles = loadRoles({});
          const ml = modelList(roles.code.ref, process.env as any, undefined);
          const items = ml.models.map((m: any) => ({ value: m.ref, label: `${m.available ? ' ' : '-'} ${m.ref}  ${m.label}` }));
          setPicker({ title: 'models', items, onPick: (v) => {
            const picked = ml.models.find((m: any) => m.ref === v);
            if (picked && !picked.available) { push({ role: "system", text: `${v} is unavailable: ${picked.reason ?? 'no key'}` }); return; }
            setModel(v); push({ role: "system", text: `the next turn runs on ${v}` }); setInput(''); inputRef.current = '';
          } });
           openDialog('picker');
        } catch (e) { say('error: ' + (e as Error).message); }
        return;
      }
      case 'permission': {
        if (rest[0]) {
          if (!['auto', 'read-only', 'plan', 'workspace'].includes(rest[0])) { say(`unknown mode: ${rest[0]} (auto | read-only | plan | workspace)`, 'red'); return; }
          setPermission(rest[0]); say(`permission: ${rest[0]}`); return;
        }
        const items = [
          { value: 'auto', label: 'auto' },
          { value: 'read-only', label: 'read-only' },
          { value: 'plan', label: 'plan' },
          { value: 'workspace', label: 'workspace' },
        ];
        setPicker({ title: 'permission', items, onPick: (v) => { setPermission(v); push({ role: "system", text: `permission: ${v}` }); setInput(''); inputRef.current = ''; } });
         openDialog('picker');
        return;
      }
      case 'output-style': {
        try {
          const { loadOutputStyles, loadOutputStyleSetting } = require('../../core/output-styles/styles.ts');
          const styles = loadOutputStyles(cediaHome());
          const cur = loadOutputStyleSetting(cediaHome());
          const items = styles.map((s: any) => ({ value: s.name, label: `${s.name === cur ? '*' : ' '} ${s.name}  ${s.description ?? ''}` }));
          setPicker({ title: 'output styles', items, onPick: (v) => {
            try {
              const pp = join(cediaHome(), 'settings.json');
              let raw: Record<string, unknown> = {};
              try { raw = JSON.parse(fsRead(pp, 'utf8')); } catch {}
              raw.outputStyle = v;
              fsWrite(pp, JSON.stringify(raw, null, 2) + '\n');
              push({ role: "system", text: `output style: ${v} (takes effect next turn)` });
            } catch (e) { push({ role: "system", text: `error: ${(e as Error).message}` }); }
          } });
         openDialog('picker');
        } catch (e) { say('error: ' + (e as Error).message); }
        return;
      }
      case 'suggest': {
        say('asking for a suggestion…');
        busyRef.current = true;
        void (async () => {
          try {
            const { generateSuggestion } = await import('../../core/suggestions/prompt-suggestion.ts');
            const sug = await generateSuggestion({ cwd: args.cwd, model: model ?? args.model, lastResult: 'continue' });
            if (sug) { setSuggestion(sug.text); say(`suggestion: ${sug.text} (Tab to accept)`); }
            else say('no suggestion right now', 'red');
          } catch (e) { say(`suggestion failed: ${(e as Error).message}`, 'red'); }
          finally { busyRef.current = false; }
        })();
        return;
      }
      case 'trust': {
        acceptTrust(cediaHome());
        setTrustOpen(false);
        syncOnboardingRef.current();
        push({ role: 'system', text: 'trust accepted' });
        return;
      }
      case 'onboarding': {
        if (rest[0] === 'accept') {
          acceptTrust(cediaHome());
          setTrustOpen(false);
          syncOnboardingRef.current();
          push({ role: 'system', text: 'trust accepted' });
          return;
        }
        if (rest[0] && rest[0] !== 'accept') {
          try { markStep(rest[0]); } catch {}
          setNotice(null);
        }
        try {
          const s = loadOnboarding(cediaHome());
          const done = completedNames(s);
          const theme = (() => { try { return String((readSettings(join(cediaHome(), 'settings.json')) as Record<string, unknown>)?.theme ?? '(not set)'); } catch { return '(unreadable)'; } })();
          const keyNames = ['ANTHROPIC_API_KEY', 'CEDIA_ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'].filter((k) => !!process.env[k]);
          const detail: Record<string, string> = {
            preflight: `bun ${Bun.version} · ${process.platform}`,
            theme: String(theme),
            apiKey: keyNames.length ? keyNames.join(', ') : 'none in env',
            trust: s.hasTrustDialogAccepted ? 'accepted' : 'pending — /onboarding accept',
            terminal: `${process.env.TERM ?? '?'} · ${process.env.COLORTERM ?? 'no truecolor'}`,
          };
          const rows = ONBOARDING_STEPS.map((st) => `${done.has(st) ? '✓' : '○'} ${st} — ${detail[st] ?? ''}`);
          push({ role: 'system', text: ['onboarding:', ...rows, isComplete(cediaHome()) ? 'complete' : 'use /onboarding <step> to mark one done'].join('\n') });
        } catch (e) { push({ role: 'system', text: `onboarding: ${(e as Error).message}` }); }
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
          const list = store.list().filter((t) => !t.archived);
          say(list.length ? list.map((t, i) => `${i + 1}. ${t.id}  ${t.title}`).join('\n') : 'no threads');
          return;
        }
        if (/^\d+$/.test(rest[0])) {
          const pick = store.list().filter((t) => !t.archived)[Number(rest[0]) - 1];
          if (!pick) { say(`no thread #${rest[0]}`); return; }
          switchThread(pick.id);
          say(`going on with ${pick.id}`);
          return;
        }
        if (!store.has(rest[0])) { say(`no thread ${rest[0]}`); return; }
        switchThread(rest[0]);
        say(`going on with ${rest[0]}`);
        return;
      }
      case 'resume': {
        if (!rest[0]) {
          const threads = store.list().filter((t) => !t.archived);
          if (!threads.length) { say('no threads'); return; }
          const items = threads.map((t) => ({ value: t.id, label: `${t.id}  ${t.title}${t.updatedAt ? `  (${ago(t.updatedAt)})` : ''} · ${t.messages?.length ?? 0} msgs` }));
          setPicker({ title: 'resume', items, onPick: (v) => { switchThread(v); push({ role: 'system', text: `going on with ${v}` }); } });
          openDialog('picker');
          return;
        }
        if (!store.has(rest[0])) { say(`no thread ${rest[0]}`); return; }
        switchThread(rest[0]); say(`going on with ${rest[0]}`); return;
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
      case 'color':
      case 'theme': {
        const t = rest[0];
        if (t && t !== 'dark' && t !== 'light') { say(`unknown theme: ${t} (dark | light)`); return; }
        if (t) {
          try {
            const pp = join(cediaHome(), 'settings.json');
            const raw = JSON.parse(fsRead(pp, 'utf8')) as Record<string, unknown>;
            raw.theme = t;
            fsWrite(pp, JSON.stringify(raw, null, 2) + '\n');
          } catch { /* ignore */ }
          setThemeTick((n) => n + 1);
          syncOnboardingRef.current();
          say(`theme: ${t}`);
          return;
        }
        say(`theme: ${themeName} (dark | light)`);
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
        try {
          const raw = readSettings(join(cediaHome(), 'settings.json')) as { hooks?: Record<string, unknown[]> };
          const hooks = raw.hooks ?? {};
          const kinds = ['preToolUse', 'postToolUse', 'stop'];
          const lines = kinds.map((k) => `${k}: ${Array.isArray(hooks[k]) ? (hooks[k] as unknown[]).length : 0}`);
          say(`hooks (${join(cediaHome(), 'settings.json')}):\n` + lines.join('\n'));
        } catch (e) { say(`hooks: ${(e as Error).message}`, 'red'); }
        return;
      }
      case 'effort': {
        const lvl = rest[0];
        if (!lvl) { say(`effort: ${effort ?? '(default)'}`); return; }
        if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(lvl)) { say(`unknown effort: ${lvl} (low | medium | high | xhigh | max)`); return; }
        setEffort(lvl as 'low' | 'medium' | 'high' | 'xhigh' | 'max');
        try {
          const pp = join(cediaHome(), 'settings.json');
          const raw = JSON.parse(fsRead(pp, 'utf8')) as Record<string, unknown>;
          raw.effort = lvl;
          fsWrite(pp, JSON.stringify(raw, null, 2) + '\n');
        } catch { /* session-only if settings unwritable */ }
        say(`effort: ${lvl} (takes effect next turn)`);
        return;
      }
      case 'compact': {
        say('compaction/handoff runs automatically when context grows long');
        return;
      }
      case 'fast': {
        try {
          const pp = join(cediaHome(), 'settings.json');
          let raw: Record<string, unknown> = {};
          try { raw = JSON.parse(fsRead(pp, 'utf8')) as Record<string, unknown>; } catch {}
          const cur = raw.fast === true;
          raw.fast = !cur;
          fsWrite(pp, JSON.stringify(raw, null, 2) + '\n');
          say(`fast mode: ${raw.fast ? 'on' : 'off'}`);
        } catch (e) { say(`fast mode: ${(e as Error).message}`, 'red'); }
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
        say(`vim mode: ${vimMode === 'insert' ? 'normal' : 'insert'} (v for visual)`);
        return;
      }
      case 'palette': {
        const cmdItems = INK_COMMANDS.map((c) => ({ value: c.name, label: `/${c.name}  ${c.description}` }));
        const skills = (() => { try { return loadSkills(args.cwd, cediaHome()); } catch { return []; } })();
        const items = [...cmdItems, ...skills.map((sk) => ({ value: sk.name, label: `${sk.name}  ${sk.description}` }))];
        setPicker({ title: 'commands', items, onPick: (v) => { setInput(`/${v} `); inputRef.current = `/${v} `; } });
        openDialog('picker');
        setPickerSelected(0);
        return;
      }
      case 'doctor': {
        const lines = [`cedia doctor`, `version: ${versionInfo().version} · bun ${Bun.version}`];
        try {
          const g = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: args.cwd });
          const sha = g.stdout.toString().trim();
          if (sha) lines.push(`build: ${sha}`);
        } catch { /* not a git checkout */ }
        lines.push(`cwd: ${args.cwd}`);
        try {
          JSON.parse(fsRead(join(cediaHome(), 'settings.json'), 'utf8'));
          lines.push(`settings: ok`);
        } catch (e) { lines.push(`settings: unreadable (${(e as Error).message})`); }
        lines.push(`keybindings: ${loadedKeybindings.length} loaded`);
        try {
          const { servers } = listMcp();
          lines.push(`mcp: ${servers.length ? servers.map((s) => s.name).join(', ') : 'none configured'}`);
        } catch (e) { lines.push(`mcp: error (${(e as Error).message})`); }
        const sandbox = Bun.which('bwrap') ?? Bun.which('sandbox-exec');
        lines.push(`sandbox: ${sandbox ?? 'unavailable'}`);
        const keys = ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'].filter((k) => !!process.env[k]);
        lines.push(`api keys: ${keys.length ? keys.join(', ') : 'none in env'} (names only)`);
        lines.push(`onboarding: ${isComplete(cediaHome()) ? 'complete' : 'pending'}`);
        lines.push(`terminal: ${process.env.TERM ?? '?'} ${columns}x${rows}`);
        say(lines.join('\n'));
        return;
      }
      case 'statusline': {
        const cmd = rest.join(' ').trim();
        if (!cmd) { say('usage: /statusline <command>'); return; }
        const out = runStatusLineCommand(cmd, { model: model ?? args.model ?? 'auto', workspace: args.cwd, costUsd: spent, contextWindow: context, permissionMode: permission, vimMode });
        say(out || '(no output)');
        return;
      }
      default:
        say(`unknown command /${name}; /help lists them`);
    }
  }, [args, messages, running, store, thread, exit, spent, context, goal, transcriptExpanded, openDialog, model, permission, effort, switchThread, vimMode]);

  const submit = useCallback(async (text: string, planWhen?: 'always' | 'never') => {
    if (!text.trim()) return;
    if (busyRef.current) return; // same-tick double fire (VimInput + keybinding both submit Enter)
    if (running) { push({ role: 'system', text: 'a turn is running: wait for it, or stop it with Esc' }); return; }
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
      setInput('');
      inputRef.current = '';
      if (/^(y|yes)$/i.test(trimmedText)) { void p.yes(stop.signal); return; }
      push({ role: 'system', text: `not done: ${p.what}` });
      if (/^(n|no)$/i.test(trimmedText)) return;
      // anything else falls through as a new prompt/command
    }
    if (text.trim().startsWith('/')) {
      push({ role: 'user', text });
      setInput('');
      inputRef.current = '';
      handleCommand(trimmedText.slice(1));
      return;
    }
    busyRef.current = true;
    setMessages((m) => [...m, { role: 'user', text }]);
    setInput('');
    historyRef.current.push(text);
    histPos.current = -1;
    setRunning(true);
    setActivity('starting');
    setThinkingText('');
    thinkingRef.current = '';
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
              thinkingRef.current = '';
              setThinkingText('');
            } else if (e.type === 'thinking_delta') {
              thinkingRef.current = (thinkingRef.current + e.delta).slice(-2000);
              setThinkingText(thinkingRef.current);
            } else if (e.type === 'thinking_end') {
              const t = thinkingRef.current.trim();
              thinkingRef.current = '';
              setThinkingText('');
              if (t) push({ role: 'system', text: t, dim: true });
            }
          } else if (m.type === 'event') {
            const e = m.event as SessionEvent;
            if (e.kind === 'tool_intent') {
              toolInputByCallRef.current[e.callId] = e.input;
              toolStartByCallRef.current[e.callId] = Date.now();
              toolNameByCallRef.current[e.callId] = e.tool;
              setMessages((prev) => [...prev, { role: 'tool', text: `● ${e.tool} ${String(e.input?.command ?? e.input?.path ?? '').slice(0, 80)}`, status: 'running' }]);
              setActivity(`running ${e.tool}`);
            }
            if (e.kind === 'tool_result') {
              const lines = e.output.text.split('\n');
              const first = lines.find((l) => l.trim()) ?? '';
              const exit = e.output.exitCode !== undefined ? ` exit=${e.output.exitCode}` : '';
              const started = toolStartByCallRef.current[e.callId];
              const took = started !== undefined ? ` · ${((Date.now() - started) / 1000).toFixed(1)}s` : '';
              delete toolStartByCallRef.current[e.callId];
              const toolName = toolNameByCallRef.current[e.callId] ?? '';
              delete toolNameByCallRef.current[e.callId];
              const looksDiff = /^(edit|write|filewrite|sed)$/i.test(toolName) && lines.some((l, i) => i > 0 && /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
              const body = looksDiff ? lines.slice(0, 40).join('\n').slice(0, 1500) : `${first.slice(0, 120)}`;
              setMessages((prev) => [...prev, { role: 'tool', text: `  ⎿ ${e.output.isError ? 'ERR ' : ''}${body}${exit}${took}`, status: e.output.isError ? 'error' : 'success' }]);
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
    const turnStart = Date.now();
    try {
      const result = await runHeadless(
        { ...args, model: model ?? args.model, permission: permission ?? args.permission, ...(effort ? { effort } : {}), cacheTtl: args.cacheTtl ?? '1h', streamingTools: true, prompt: text, outputFormat: 'stream-json', ...(thread ? { thread } : {}), ...(goal ? { goal } : {}), ...(planWhen ? { planWhen } : {}), signal: stop.signal },
        handleChunk,
      );
      setThread(result.thread ?? thread);
      if (typeof result.peakContext === 'number') setContext(result.peakContext);
      resultCost = result.costUsd ?? 0;
      setSpent((prev) => prev + resultCost);
      if (typeof result.timing?.outputTokPerSec === 'number') setLastRate(result.timing.outputTokPerSec);
      setMessages((m) => [...m, { role: 'system', dim: true, text: `✳ done · ${result.numTurns} turn${result.numTurns === 1 ? '' : 's'} · ${effModel?.label ?? model ?? 'auto'} · ${((Date.now() - turnStart) / 1000).toFixed(1)}s${typeof result.timing?.outputTokPerSec === 'number' ? ` · ${Math.round(result.timing.outputTokPerSec)} tok/s` : ''} · $${result.costUsd.toFixed(4)}` }]);
      // A run that ended asking waits for the owner: surface the question with its options, answered by the
      // next prompt. (The PermissionDialog overlay stays for a future binding; text carries it for now.)
      if (result.subtype === 'asked' && result.question) {
        push({ role: 'system', text: askedBannerText(result.question) });
      }
      if (loadPromptSuggestions(args.promptSuggestions)) {
        void (async () => {
          try {
            const { generateSuggestion } = await import('../../core/suggestions/prompt-suggestion.ts');
            const sug = await generateSuggestion({ cwd: args.cwd, model: model ?? args.model, lastResult: result.subtype });
            if (sug) setSuggestion(sug.text);
          } catch {}
        })();
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'system', text: `✗ error: ${(e as Error).message}`, tone: 'red' }]);
    } finally {
      busyRef.current = false;
      setRunning(false);
      setActivity('');
      const newSpent = spent + resultCost;
      if (newSpent >= lastCostThresholdRef.current + 1) {
        push({ role: 'system', text: `cost threshold crossed: $${Math.floor(newSpent)}` });
        lastCostThresholdRef.current = Math.floor(newSpent);
      }
      lastActivityRef.current = Date.now();
    }
  }, [args, running, thread, handleCommand, goal, picker, closeDialog, permission, model, effort, effModel]);



  const { stdin } = useStdin();
  React.useEffect(() => {
    if (process.env.CEDIA_MDM_URL) void fetchMdmSettings().then((d) => { if (Object.keys(d).length) { /* cached by server; reload not needed */ } }).catch(() => {});
  }, []);
  React.useEffect(() => {
    const home = cediaHome();
    setLoadedKeybindings(loadKeybindings(home));
    return watchKeybindings(home, setLoadedKeybindings);
  }, []);
  React.useEffect(() => {
    if (!stdin) return;
    const pointer = (termCol: number, termRow: number) => {
      const hit = rowMapRef.current.rowAt(termRow - 1);
      if (!hit) return;
      const msg = displayRef.current[hit.index];
      const text = truncateLongText(msg?.text ?? '');
      const col = offsetAt(
        text,
        paintedWidth(msg?.role, columnsRef.current, screenReaderRef.current),
        hit.rowInSpan,
        paintedCol(termCol, msg?.role, screenReaderRef.current),
      );
      return { index: hit.index, col };
    };
    const handler = (data: Buffer) => {
      const s = data.toString();
      if (/\x1b\[<64;/.test(s)) {
        const maxOff = Math.max(0, displayRef.current.length - 1);
        setScrollOffset((o) => Math.min(maxOff, o + 3));
      }
      if (/\x1b\[<65;/.test(s)) setScrollOffset((o) => Math.max(0, o - 3));
      const press = /\x1b\[<0;(\d+);(\d+)M/.exec(s);
      if (press) {
        const at = pointer(parseInt(press[1]!, 10), parseInt(press[2]!, 10));
        if (at) {
          const next = { aMsg: at.index, aCol: at.col, bMsg: at.index, bCol: at.col };
          selectionRef.current = next;
          selectingRef.current = true;
          setSelection(next);
          setSelecting(true);
        }
      }
      const drag = /\x1b\[<32;(\d+);(\d+)M/.exec(s);
      if (drag && selectingRef.current) {
        const at = pointer(parseInt(drag[1]!, 10), parseInt(drag[2]!, 10));
        if (at) {
          setSelection((sel) => {
            if (!sel) return null;
            const next = { ...sel, bMsg: at.index, bCol: at.col };
            selectionRef.current = next;
            return next;
          });
        }
      }
      const release = /\x1b\[<0;(\d+);(\d+)m/.exec(s);
      if (release && selectingRef.current) {
        selectingRef.current = false;
        setSelecting(false);
        const sel = selectionRef.current;
        if (!sel) return;
        if (sel.aMsg === sel.bMsg && sel.aCol === sel.bCol) {
          selectionRef.current = null;
          setSelection(null);
          return;
        }
        const lo = Math.min(sel.aMsg, sel.bMsg);
        const hi = Math.max(sel.aMsg, sel.bMsg);
        const parts: string[] = [];
        for (let i = lo; i <= hi; i++) {
          const m = displayRef.current[i];
          if (!m) continue;
          const text = truncateLongText(m.text);
          const bounds = selectionBounds(sel, i, text.length);
          if (!bounds || bounds.end <= bounds.start) continue;
          parts.push(text.slice(bounds.start, bounds.end));
        }
        const text = parts.join('\n');
        if (!text) {
          selectionRef.current = null;
          setSelection(null);
          return;
        }
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
  }, [stdin]);

  syncOnboardingRef.current = (openTrust = false) => {
    try {
      const home = cediaHome();
      const prev = loadOnboarding(home);
      let themeOk = false;
      try {
        const raw = readSettings(join(home, 'settings.json')) as { theme?: unknown };
        themeOk = raw.theme === 'dark' || raw.theme === 'light';
      } catch { themeOk = false; }
      const next = reconcileOnboarding(prev, {
        preflight: typeof Bun !== 'undefined' && Bun.version.length > 0,
        theme: themeOk,
        apiKey: ['ANTHROPIC_API_KEY', 'CEDIA_ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'].some((name) => !!process.env[name]),
        trust: prev.hasTrustDialogAccepted === true,
        terminal: Boolean(process.stdout.isTTY) && (process.stdout.columns ?? 0) >= 20,
      });
      const same = JSON.stringify(prev.completed ?? []) === JSON.stringify(next.completed)
        && !!prev.hasTrustDialogAccepted === !!next.hasTrustDialogAccepted;
      if (!same) saveOnboarding(next, home);
      if (openTrust && !next.hasTrustDialogAccepted) {
        setTrustOpen(true);
        setTrustSelected(1);
        return;
      }
      if (!next.hasTrustDialogAccepted) return;
      if (!isComplete(home)) {
        const names = completedNames(next);
        const pending = ONBOARDING_STEPS.filter((step) => !names.has(step));
        const mode = permissionRef.current ?? 'auto';
        setNotice(`onboarding: ${pending.join(', ')} pending — /onboarding accept. Shift+Tab cycles the permission setting. This run is ${mode}.`);
      } else {
        setNotice((n) => (n?.startsWith('onboarding:') ? null : n));
      }
    } catch {}
  };
  React.useEffect(() => { syncOnboardingRef.current(true); }, []);
  React.useEffect(() => {
    let cmd: string | undefined;
    try {
      const raw = JSON.parse(require('node:fs').readFileSync(join(cediaHome(), 'settings.json'), 'utf8')) as { statusLine?: unknown };
      if (typeof raw?.statusLine === 'string') cmd = raw.statusLine;
      else if (raw?.statusLine && typeof (raw.statusLine as { command?: unknown }).command === 'string') cmd = (raw.statusLine as { command: string }).command;
    } catch {}
    if (!cmd) { setStatusLineOutput(''); return; }
    const out = runStatusLineCommand(cmd, { model: model ?? args.model ?? 'auto', workspace: args.cwd, costUsd: spent, contextWindow: context, permissionMode: permission, vimMode });
    setStatusLineOutput(out);
  }, [spent, context, thread, args.model, model, args.cwd, permission, vimMode]);
  const { columns, rows } = useWindowSize();
  // Rows reserved for input, status, dividers and margins — overlays are capped
  // to this budget so the chat box always stays on screen (like cc's modals).
  const overlayBudget = Math.max(4, rows - 12);
  const screenReader = useIsScreenReaderEnabled() || process.env.CEDIA_SCREEN_READER === '1' || process.env.CEDIA_AX_SCREEN_READER === '1';
  const displayMessages = transcriptExpanded ? messages.filter((m) => showThinking || !m.dim) : messages.filter((m) => m.role !== 'tool' && (showThinking || !m.dim));
  const windowSize = Math.max(5, rows - 6);
  // Full message range: the height-budgeted slice below decides what fits,
  // so the offset may travel to the very first message (count-based windows
  // would strand tall single messages).
  const maxScrollOffset = Math.max(0, displayMessages.length - 1);
  React.useEffect(() => {
    setScrollOffset((o) => (o > maxScrollOffset ? maxScrollOffset : o));
  }, [columns, rows, displayMessages.length]);
  // Height-budgeted window with cached estimates and message overscan.
  // windowSize stays as the PgUp/PgDn step. The budget reserves the header,
  // both scroll indicators, the input box, the model line and the status bar.
  const heightBudget = Math.max(3, rows - 8);
  React.useEffect(() => {
    heightCacheRef.current.clear();
  }, [columns, displayMessages.length, screenReader, transcriptExpanded, showThinking]);
  const heightAt = (index: number): number => {
    const msg = displayMessages[index];
    const text = truncateLongText(msg?.text ?? '');
    const width = paintedWidth(msg?.role, columns, screenReader);
    const key = heightCacheKey(index, width, text.length, msg?.role ?? '');
    return heightCacheRef.current.lines(key, () => estimateLines(text, width));
  };
  const { start: renderStart, end: renderEnd } = visibleWindow({
    count: displayMessages.length,
    scrollOffset,
    budget: heightBudget,
    overscan: 3,
    heightAt,
  });

  const visibleMessages = displayMessages.slice(renderStart, renderEnd);
  const aboveHidden = renderStart;
  const belowHidden = Math.max(0, displayMessages.length - renderEnd);
  columnsRef.current = columns;
  screenReaderRef.current = screenReader;
  selectionRef.current = selection;
  selectingRef.current = selecting;
  displayRef.current = displayMessages;
  {
    const bands: WalkBand[] = [{ kind: 'chrome', rows: 2 }];
    if (displayMessages.length > 0 && (scrollOffset > 0 || aboveHidden > 0)) bands.push({ kind: 'chrome', rows: 1 });
    for (let i = renderStart; i < renderEnd; i++) {
      bands.push({
        kind: 'message',
        index: i,
        rows: heightAt(i),
      });
    }
    if (thinkingText && showThinking) {
      bands.push({ kind: 'chrome', rows: estimateLines(thinkingText.slice(-500), Math.max(10, columns - 2)) });
    }
    if (running && activity) bands.push({ kind: 'chrome', rows: 1 });
    rowMapRef.current = rowMapFromWalk(bands);
  }
  // Transcript search hits (derived): global indices into displayMessages.
  const searchHits: number[] = (() => {
    const q = transcriptSearch.query.trim().toLowerCase();
    if (!transcriptSearch.open || !q) return [];
    const out: number[] = [];
    displayMessages.forEach((m, i) => { if (m.text.toLowerCase().includes(q)) out.push(i); });
    return out;
  })();
  const ctx = activeContext({
    permissionNotice: permissionDialog !== null,
    picker: focusedDialog === 'picker' && picker !== null,
    settings: settingsOpen,
    messageSelector: focusedDialog === 'messageSelector',
    historySearch: focusedDialog === 'historySearch',
    transcriptSearch: transcriptSearch.open,
    autocomplete: mentionOpen || autoOpen,
  });
  const gate = vimInputGate(ctx, trustOpen);
  const closeSettingsStep = () => {
    if (editingKey) { setEditingKey(null); setEditValue(''); return; }
    if (settingsTab === 'config' && settingsQuery) { setSettingsQuery(''); return; }
    setSettingsOpen(false);
    setSettingsQuery('');
  };
  const closeOverlay = (which: LiveContext) => {
    if (which === 'Confirmation') { setPermissionDialog(null); return; }
    if (which === 'Select') { closeDialog('picker'); setPicker(null); setPickerSelected(0); return; }
    if (which === 'Settings') { closeSettingsStep(); return; }
    if (which === 'MessageSelector') {
      setMessageSelector({ open: false, selected: 0 });
      closeDialog('messageSelector');
      return;
    }
    if (which === 'HistorySearch') {
      setHistorySearch({ open: false, query: '', selected: 0 });
      closeDialog('historySearch');
      return;
    }
    if (which === 'Transcript') { setTranscriptSearch({ open: false, query: '', selected: 0 }); return; }
    if (which === 'Autocomplete') {
      if (mentionOpen) { setMentionDismissed(true); return; }
      setAutoDismissed(true);
    }
  };
  const applyCancel = (step: ReturnType<typeof cancelStep>) => {
    if (step === 'abort-turn') { stopRef.current?.abort(); setActivity('stopping…'); return; }
    if (step === 'close-overlay') { closeOverlay(ctx); return; }
    if (step === 'clear-input') { setInput(''); inputRef.current = ''; return; }
    exit();
  };
  chordDispatchRef.current = (command) => {
    if (command === 'scrollTop') { setScrollOffset(maxScrollOffset); return; }
    if (command === 'scrollBottom') { setScrollOffset(0); return; }
  };
  useEffect(() => {
    if (vimMode !== 'normal' || ctx !== 'Chat') chordRef.current.reset();
  }, [vimMode, ctx]);
  useInput((input, key) => {
    if (trustOpen) {
      if (key.upArrow || key.downArrow) { setTrustSelected((s) => (s === 0 ? 1 : 0)); return; }
      if (input === 'y' || input === 'Y') {
        acceptTrust(cediaHome());
        setTrustOpen(false);
        syncOnboardingRef.current();
        push({ role: 'system', text: 'trust accepted' });
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        push({ role: 'system', text: 'not trusted: leaving' });
        exit();
        return;
      }
      if (key.return) {
        if (trustSelected === 1) {
          acceptTrust(cediaHome());
          setTrustOpen(false);
          syncOnboardingRef.current();
          push({ role: 'system', text: 'trust accepted' });
        } else {
          push({ role: 'system', text: 'not trusted: leaving' });
          exit();
        }
        return;
      }
      return;
    }
    if (key.ctrl && input === 'c') {
      applyCancel(cancelStep({
        running,
        overlay: ctx !== 'Chat',
        editorEmpty: inputRef.current.length === 0,
      }));
      return;
    }
    if (ctx === 'Autocomplete') {
      const autoCmd = (() => {
        const id = inkKeyId(input, key);
        return id ? findCommand(resolveBindings(loadedKeybindings), id, 'Autocomplete') : undefined;
      })();
      if (mentionOpen) {
        const sel = Math.min(mentionSelected, mentionItems.length - 1);
        if (autoCmd === 'cancel') { setMentionDismissed(true); return; }
        if (autoCmd === 'selectUp') { setMentionSelected((s) => Math.max(0, s - 1)); return; }
        if (autoCmd === 'selectDown') { setMentionSelected((s) => Math.min(mentionItems.length - 1, s + 1)); return; }
        if (autoCmd === 'accept') {
          const item = mentionItems[sel];
          if (item) {
            notePick(item.value);
            const next = input.replace(/@[\w./-]*$/, `${item.value} `);
            setInput(next);
            setMentionDismissed(true);
          }
          return;
        }
        return;
      }
      if (autoOpen) {
        const sel = Math.min(autoSelected, autoItems.length - 1);
        if (autoCmd === 'cancel') { setAutoDismissed(true); return; }
        if (autoCmd === 'selectUp') { setAutoSelected((s) => Math.max(0, s - 1)); return; }
        if (autoCmd === 'selectDown') { setAutoSelected((s) => Math.min(autoItems.length - 1, s + 1)); return; }
        if (autoCmd === 'accept') {
          const item = autoItems[sel];
          if (item) { notePick(item.value); setInput(`/${item.value} `); setAutoDismissed(true); }
          return;
        }
        return;
      }
      return;
    }
    if (ctx !== 'Chat') {
      const overlayCmd = (() => {
        const id = inkKeyId(input, key);
        return id ? findCommand(resolveBindings(loadedKeybindings), id, ctx) : undefined;
      })();
      if (ctx === 'Confirmation') {
        if (overlayCmd === 'dismiss') setPermissionDialog(null);
        return;
      }
      if (ctx === 'Select' && picker) {
        if (overlayCmd === 'close') { closeDialog('picker'); setPicker(null); setPickerSelected(0); return; }
        if (overlayCmd === 'selectUp') { setPickerSelected((s) => Math.max(0, s - 1)); return; }
        if (overlayCmd === 'selectDown') { setPickerSelected((s) => Math.min(picker.items.length - 1, s + 1)); return; }
        if (overlayCmd === 'accept') {
          const before = inputRef.current;
          const item = picker.items[pickerSelected];
          if (item) { picker.onPick(item.value); }
          closeDialog('picker'); setPicker(null); setPickerSelected(0);
          if (inputRef.current === before) { setInput(''); inputRef.current = ''; }
          return;
        }
        return;
      }
      if (ctx === 'Settings') {
        if (overlayCmd === 'close') { closeSettingsStep(); return; }
        const tabs: Array<'status' | 'config' | 'usage' | 'stats'> = ['status', 'config', 'usage', 'stats'];
        if (overlayCmd === 'nextTab') {
          setSettingsTab((t) => tabs[(tabs.indexOf(t) + 1) % tabs.length]!);
          setConfigSelected(0);
          return;
        }
        if (overlayCmd === 'prevTab') {
          setSettingsTab((t) => tabs[(tabs.indexOf(t) - 1 + tabs.length) % tabs.length]!);
          setConfigSelected(0);
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
                try { v = JSON.parse(editValue); } catch {}
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
              const target = keys[Math.min(configSelected, Math.max(0, keys.length - 1))];
              if (target && (keys.length === 1 || configSelected < keys.length)) {
                setEditingKey(target);
                setEditValue(JSON.stringify(raw[target]) ?? '');
                return;
              }
            } catch {}
          }
          if (input === ' ') {
            try {
              const pp = join(cediaHome(), 'settings.json');
              const raw = readSettings(pp) as Record<string, unknown>;
              const q = settingsQuery.toLowerCase();
              const keys = Object.keys(raw).filter((k) => !q || k.toLowerCase().includes(q));
              const target = keys[Math.min(configSelected, Math.max(0, keys.length - 1))];
              if (target && typeof raw[target] === 'boolean') {
                raw[target] = !raw[target];
                fsWrite(pp, JSON.stringify(raw, null, 2) + '\n');
                push({ role: 'system', text: `setting ${target} = ${String(raw[target])}` });
              }
            } catch {}
            return;
          }
          if (key.upArrow) {
            setConfigSelected((s) => Math.max(0, s - 1));
            return;
          }
          if (key.downArrow) {
            try {
              const raw = readSettings(join(cediaHome(), 'settings.json')) as Record<string, unknown>;
              const q = settingsQuery.toLowerCase();
              const n = Object.keys(raw).filter((k) => !q || k.toLowerCase().includes(q)).length;
              setConfigSelected((s) => Math.min(Math.max(0, n - 1), s + 1));
            } catch { setConfigSelected((s) => s + 1); }
            return;
          }
          if (key.backspace || key.delete) { setSettingsQuery((q) => q.slice(0, -1)); return; }
          if (input && !key.ctrl && !key.meta && !key.return && input.length === 1 && input >= ' ') {
            setSettingsQuery((q) => q + input);
            return;
          }
        }
        return;
      }
      if (ctx === 'MessageSelector') {
        const runs = thread ? runLines(store.read(thread)) : [];
        if (overlayCmd === 'close') { setMessageSelector({ open: false, selected: 0 });
          closeDialog('messageSelector'); return; }
        if (overlayCmd === 'selectUp') { setMessageSelector((m) => ({ ...m, selected: Math.max(0, m.selected - 1) })); return; }
        if (overlayCmd === 'selectDown') {
          if (!runs.length) return;
          setMessageSelector((m) => ({ ...m, selected: Math.min(runs.length - 1, m.selected + 1) }));
          return;
        }
        if (overlayCmd === 'accept') {
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
      if (ctx === 'HistorySearch') {
        if (overlayCmd === 'close') { setHistorySearch({ open: false, query: '', selected: 0 }); closeDialog('historySearch'); return; }
        if (overlayCmd === 'selectUp') { setHistorySearch((h) => ({ ...h, selected: Math.max(0, h.selected - 1) })); return; }
        if (overlayCmd === 'selectDown') {
          const filtered = historyRef.current.filter((h) => h.toLowerCase().includes(historySearch.query.toLowerCase()));
          if (!filtered.length) return;
          setHistorySearch((h) => ({ ...h, selected: Math.min(filtered.length - 1, h.selected + 1) }));
          return;
        }
        if (overlayCmd === 'accept') {
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
      if (ctx === 'Transcript') {
        if (overlayCmd === 'close') { setTranscriptSearch({ open: false, query: '', selected: 0 }); return; }
        if (overlayCmd === 'selectUp') { setTranscriptSearch((h) => ({ ...h, selected: Math.max(0, h.selected - 1) })); return; }
        if (overlayCmd === 'selectDown') { setTranscriptSearch((h) => ({ ...h, selected: Math.min(Math.max(0, searchHits.length - 1), h.selected + 1) })); return; }
        if (overlayCmd === 'jump') {
          const index = searchHits[transcriptSearch.selected];
          if (index !== undefined) setScrollOffset(offsetForIndex(displayMessages.length, index));
          return;
        }
        if (key.backspace || key.delete) { setTranscriptSearch((h) => ({ ...h, query: h.query.slice(0, -1), selected: 0 })); return; }
        if (input && !key.ctrl && !key.meta) { setTranscriptSearch((h) => ({ ...h, query: h.query + input, selected: 0 })); return; }
        return;
      }
      return;
    }
    if (vimMode === 'normal') {
      const id = inkKeyId(input, key);
      if (id && !key.ctrl && !key.meta) {
        const status = chordRef.current.push(id);
        if (status === 'handled' || status === 'pending') return;
      } else {
        chordRef.current.reset();
      }
    }
    if (key.home) {
      setScrollOffset(maxScrollOffset);
      return;
    }
    if (key.end) {
      setScrollOffset(0);
      return;
    }
    if (key.pageUp) {
      setScrollOffset((o) => Math.min(maxScrollOffset, o + windowSize));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((o) => Math.max(0, o - windowSize));
      return;
    }
    if (key.escape) {
      if (running) { stopRef.current?.abort(); setActivity('stopping…'); return; }
      setSelection(null);
      setSelecting(false);
      if (transcriptSearch.query) setTranscriptSearch({ open: false, query: '', selected: 0 });
      return;
    }
    if (key.ctrl && input === 'd' && !running && inputRef.current.length === 0) {
      exit();
      return;
    }
    if (key.tab && key.shift && !running) {
      const modes = ['auto', 'plan', 'read-only', 'workspace'];
      const next = modes[(modes.indexOf(permission ?? 'auto') + 1) % modes.length]!;
      setPermission(next);
      push({ role: 'system', text: `permission mode: ${next}` });
      return;
    }
    if (key.tab && !running && input.trim().startsWith('/')) {
      setAutoDismissed(false);
      return;
    }
    if (key.tab && suggestion) { setInput(suggestion); setSuggestion(null); return; }
    if (!running) {
      const id = inkKeyId(input, key);
      const bindings = resolveBindings(loadedKeybindings);
      let cmd = id ? findCommand(bindings, id, 'Chat') : undefined;
      if (!cmd) {
        for (const b of bindings) {
          if (b.context && b.context !== 'Chat' && b.context !== 'Global') continue;
          const keyed = id !== undefined && normKey(id) === normKey(b.key);
          if (keyed || matchesKey(input, b.key as any)) { cmd = b.command; break; }
        }
      }
      if (cmd) {
        if ((cmd === 'historyUp' || cmd === 'historyDown')
          && (vimMode !== 'insert' || inputRef.current.includes('\n'))) return;
        if (cmd === 'cancel') {
          applyCancel(cancelStep({ running: false, overlay: false, editorEmpty: inputRef.current.length === 0 }));
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
    if (key.ctrl && key.shift && (input === 'p' || input === 'P')) { handleCommand('palette'); return; }
    if (key.ctrl && key.shift && (input === 'f' || input === 'F')) { setTranscriptSearch({ open: true, query: '', selected: 0 }); return; }
    if (key.meta && (input === 'p' || input === 'P')) { handleCommand('model'); return; }
    if (key.meta && (input === 'o' || input === 'O')) { handleCommand('fast'); return; }
    if (key.meta && (input === 't' || input === 'T')) {
      const next = !showThinking;
      setShowThinking(next);
      push({ role: 'system', text: `thinking ${next ? 'shown' : 'hidden'}` });
      return;
    }
    if (key.ctrl && (input === 'f' || input === 'F')) {
      setTranscriptSearch((s) => (s.query ? { ...s, open: true } : { open: true, query: '', selected: 0 }));
      return;
    }
    if (key.ctrl && (input === 'p' || input === 'P') && !running) {
      handleCommand('palette');
      return;
    }
    if (key.ctrl && (input === 'r' || input === 'R')) {
      setHistorySearch({ open: true, query: '', selected: 0 });
      openDialog('historySearch');
      return;
    }
    if (key.shift && key.upArrow && !running) {
      if (input.trim()) return;
      handleCommand('actions');
      return;
    }
    if (key.ctrl && (input === 'o' || input === 'O')) {
      if (!thread) { push({ role: 'system', text: 'no thread yet' }); return; }
      setMessageSelector({ open: true, selected: 0 });
      openDialog('messageSelector');
      return;
    }
    if (key.ctrl && (input === 'g' || input === 'G')) {
      if (running) return;
      const editor = process.env.VISUAL || process.env.EDITOR;
      if (!editor) { push({ role: 'system', text: 'no $VISUAL or $EDITOR set' }); return; }
      const tmp = join(tmpdir(), `cedia-prompt-${Date.now()}.md`);
      try {
        fsWrite(tmp, inputRef.current);
        process.stdout.write('\x1b[?1049l');
        try {
          Bun.spawnSync([editor, tmp], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
        } finally {
          process.stdout.write('\x1b[?1049h');
          process.stdout.write('\x1b[?1000h\x1b[?1006h');
        }
        const edited = fsRead(tmp, 'utf8').replace(/\n+$/, '');
        setInput(edited);
        inputRef.current = edited;
      } catch (e) {
        push({ role: 'system', text: `editor failed: ${(e as Error).message}`, tone: 'red' });
      } finally {
        try { fsUnlink(tmp); } catch {}
      }
      return;
    }
  });
  // Bottom-pinned chat (claude-code style): the outer box owns the terminal
  // height, the transcript flex-grows between the header and the input, and
  // overflow clips the top (oldest) first. The slice above already keeps the
  // newest content, so clipping only absorbs rounding.
  const termRows = Math.max(10, rows || 24);
  return (
    <Box flexDirection="column" height={screenReader ? undefined : termRows}>
      <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row">
            <Box flexDirection="column" marginRight={1}>
              <Text color={screenReader ? undefined : T.primary}>██</Text>
              <Text color={screenReader ? undefined : T.primary}>██</Text>
            </Box>
            <Box flexDirection="column">
              <Text bold={screenReader ? false : true}>cedia {versionInfo().version}</Text>
              <Text dimColor={!screenReader}>{effModel?.label ?? model ?? 'auto'} · {shortCwd(args.cwd)}</Text>
              {displayMessages.length === 0 ? <Text dimColor={!screenReader}>/help for commands · Esc stops a turn</Text> : null}
            </Box>
          </Box>
      </Box>
      {displayMessages.length === 0 ? null : (
        <Box paddingX={1}>
          {scrollOffset > 0 || aboveHidden > 0 ? <Text dimColor={screenReader ? false : true}>{screenReader ? '' : '↑ '}{aboveHidden} more above</Text> : null}
        </Box>
      )}
      <Box flexDirection="column" flexGrow={1} overflow="hidden" justifyContent="flex-end" paddingX={1}>
          {displayMessages.length === 0 ? null : (
            <>
              {visibleMessages.map((m, i) => {
            const globalIdx = renderStart + i;
            const capped = truncateLongText(m.text);
            const q = transcriptSearch.query.trim();
            const queryHit = q.length > 0 && capped.toLowerCase().includes(q.toLowerCase());
            const bounds = selection ? selectionBounds(selection, globalIdx, capped.length) : undefined;
            const hasSel = !!bounds && bounds.end > bounds.start;
            const fullySelected = messageFullySelected(selection, globalIdx, capped.length);
            const isUserRow = m.role === 'user' && !hasSel && !queryHit;
            const isToolError = m.role === 'tool' && m.status === 'error';
            const contentWidth = paintedWidth(m.role, columns, screenReader);
            const userLines = isUserRow && !screenReader
              ? capped.split('\n').map((ln) => ln.padEnd(Math.max(ln.length, contentWidth)))
              : null;
            const full = capped;
            if (screenReader) {
              return (
                <Box key={globalIdx} flexDirection="column">
                  <Text wrap="wrap">{m.role}: {m.text}</Text>
                </Box>
              );
            }
              return (
            <Box key={globalIdx} flexDirection="column" backgroundColor={fullySelected ? T.selectedBg : isUserRow ? T.userRowBg : undefined}>
              {hasSel || queryHit ? (
                <Text wrap="wrap">
                  {paintRuns(full, { query: q, selection: hasSel ? bounds : undefined }).map((sp, si) => (
                    <Text
                      key={si}
                      backgroundColor={sp.selected ? T.selectionBg : sp.hit ? T.searchHitBg : undefined}
                      color={sp.selected ? T.selectionFg : sp.hit ? T.searchHitFg : themedColorFor(T, m.role)}
                      bold={sp.hit || sp.selected}
                    >{sp.text}</Text>
                  ))}
                </Text>
              ) : m.role === 'assistant' ? (
                <Markdown>{m.text}</Markdown>
              ) : m.role === 'tool' && !isToolError && full.split('\n').some((l) => /^[+-]/.test(l)) ? (
                <Box flexDirection="column">
                  {full.split('\n').slice(0, 12).map((ln, li) => {
                    const diff = /^[+](?![+][+])/.test(ln) ? T.diffAdded : /^-(?!--)/.test(ln) ? T.diffRemoved : undefined;
                    return <Text key={li} wrap="truncate" color={screenReader ? undefined : diff} dimColor={screenReader ? false : (!diff && li > 0)}>{ln.slice(0, Math.max(20, columns - 6))}</Text>;
                  })}
                  {full.split('\n').length > 12 ? <Text dimColor={!screenReader}>…{full.split('\n').length - 12} more lines</Text> : null}
                </Box>
              ) : isUserRow && !screenReader ? (
                <>{(userLines ?? [capped]).map((ln, li) => (
                  <Text key={li} wrap="wrap" backgroundColor={T.userRowBg}>
                    <Text color={T.primary}>│ </Text>{ln}
                  </Text>
                ))}</>
              ) : (
                <Text color={screenReader ? undefined : isToolError ? T.error : m.tone === 'red' ? T.error : m.dim ? undefined : themedColorFor(T, m.role)} dimColor={screenReader ? false : !!m.dim} wrap="wrap">{full}</Text>
              )}
            </Box>
            );
          })}
              </>
          )}
          {thinkingText && showThinking ? <Text dimColor={!screenReader} wrap="wrap">{thinkingText.slice(-500)}</Text> : null}
          {running && activity ? (
            <Text color={screenReader ? undefined : T.primary}>{screenReader ? '' : `${SPINNER_FRAMES[spin % SPINNER_FRAMES.length]} `}{activity}</Text>
          ) : null}
      </Box>
      {displayMessages.length === 0 ? null : (
        <Box paddingX={1}>
          {renderEnd < displayMessages.length || belowHidden > 0 ? <Text dimColor={screenReader ? false : true}>{screenReader ? '' : '↓ '}{belowHidden} more below</Text> : null}
        </Box>
      )}
        {trustOpen ? (
          <Box flexDirection="column" paddingX={1}>
            <Text color={screenReader ? undefined : T.warning} bold={!screenReader}>Accessing workspace:</Text>
            <Text>{shortCwd(args.cwd)}</Text>
            <Text wrap="wrap">Quick safety check: is this a project you created or one you trust? If not, take a moment to review what is in this folder first.</Text>
            <Text wrap="wrap">cedia will be able to read, edit, and execute files here.</Text>
            <Text dimColor={!screenReader}>Security guide: least privilege · deny-list enforced · snapshots can undo edits</Text>
            {(["No, exit", "Yes, I trust this folder"] as const).map((label, i) => (
              <Text key={label} color={screenReader ? undefined : (i === trustSelected ? T.primary : undefined)}>{i === trustSelected ? '› ' : '  '}{label}</Text>
            ))}
            <Text dimColor={!screenReader}>Enter to confirm · Esc to cancel</Text>
          </Box>
        ) : null}
        {focusedDialog === 'picker' && picker ? (
          (() => {
            const pStart = Math.max(0, Math.min(pickerSelected - overlayBudget + 2, Math.max(0, picker.items.length - overlayBudget)));
            const pVisible = picker.items.slice(pStart, pStart + overlayBudget);
            return (
          <Box flexDirection="column" borderStyle={screenReader ? undefined : "single"} borderColor={screenReader ? undefined : T.borderActive} paddingX={1}>
            <Text bold={screenReader ? false : true} color={screenReader ? undefined : T.primary}>{picker.title}</Text>
            {pStart > 0 ? <Text dimColor={!screenReader}>…{pStart} more above</Text> : null}
            {pVisible.map((it, i) => {
              const gi = pStart + i;
              return (
              <Text key={gi} color={screenReader ? undefined : (gi === pickerSelected ? T.primary : undefined)} bold={screenReader ? false : (gi === pickerSelected)}>{gi === pickerSelected ? '› ' : '  '}{gi + 1}. {it.label}</Text>
              );
            })}
            {pStart + pVisible.length < picker.items.length ? <Text dimColor={!screenReader}>…{picker.items.length - pStart - pVisible.length} more below</Text> : null}
            <Text dimColor={!screenReader}>↑/↓ navigate · Enter select · Esc cancel</Text>
          </Box>
            );
          })()
        ) : null}
        {focusedDialog === 'historySearch' ? (
          (() => {
            const filtered = historyRef.current.filter((h) => h.toLowerCase().includes(historySearch.query.toLowerCase()));
            const hStart = Math.max(0, Math.min(historySearch.selected - overlayBudget + 2, Math.max(0, filtered.length - overlayBudget)));
            const hVisible = filtered.slice(hStart, hStart + overlayBudget);
            return (
          <Box flexDirection="column" borderStyle={screenReader ? undefined : "single"} borderColor={screenReader ? undefined : T.borderActive} paddingX={1}>
            <Text bold={screenReader ? false : true} color={screenReader ? undefined : T.primary}>history search: {historySearch.query || '(type to filter)'}</Text>
            {hVisible.map((h, i) => {
              const gi = hStart + i;
              const sel = gi === historySearch.selected;
              const padded = sel && !screenReader ? h + ' '.repeat(Math.max(0, columns - 4 - h.length)) : h;
              return (
              <Text key={gi} backgroundColor={screenReader ? undefined : (sel ? T.selectedBg : undefined)}>{padded}</Text>
              );
            })}
            {filtered.length === 0 ? <Text dimColor={!screenReader}>no matches</Text> : null}
            {hStart + hVisible.length < filtered.length ? <Text dimColor={!screenReader}>…{filtered.length - hStart - hVisible.length} more below</Text> : null}
            <Text dimColor={!screenReader}>↑↓ navigate · Enter run · Esc close</Text>
          </Box>
            );
          })()
        ) : null}
        {transcriptSearch.open ? (
          (() => {
            const maxRows = Math.max(3, Math.min(7, overlayBudget));
            const sStart = Math.max(0, Math.min(transcriptSearch.selected - maxRows + 2, Math.max(0, searchHits.length - maxRows)));
            const sVisible = searchHits.slice(sStart, sStart + maxRows);
            return (
          <Box flexDirection="column" borderStyle={screenReader ? undefined : "single"} borderColor={screenReader ? undefined : T.borderActive} paddingX={1}>
            <Text bold={screenReader ? false : true} color={screenReader ? undefined : T.primary}>search transcript: {transcriptSearch.query || '(type to filter)'}</Text>
            {sVisible.map((gi, i) => {
              const m = displayMessages[gi];
              const sel = sStart + i === Math.min(transcriptSearch.selected, Math.max(0, searchHits.length - 1));
              const snippet = m ? `${m.role}: ${m.text.split('\n')[0] ?? ''}` : '';
              return (
              <Text key={gi} wrap="truncate" color={screenReader ? undefined : (sel ? 'black' : undefined)} backgroundColor={screenReader ? undefined : (sel ? 'cyan' : undefined)}>{snippet.slice(0, Math.max(20, columns - 6))}</Text>
              );
            })}
            {searchHits.length === 0 ? <Text dimColor={!screenReader}>no matches</Text> : null}
            {sStart + sVisible.length < searchHits.length ? <Text dimColor={!screenReader}>…{searchHits.length - sStart - sVisible.length} more below</Text> : null}
            <Text dimColor={!screenReader}>↑↓ navigate · Enter jump · Esc close</Text>
          </Box>
            );
          })()
        ) : null}
        {focusedDialog === 'messageSelector' ? (
          (() => {
            const runs = thread ? runLines(store.read(thread)) : [];
            const mStart = Math.max(0, Math.min(messageSelector.selected - overlayBudget + 2, Math.max(0, runs.length - overlayBudget)));
            const mVisible = runs.slice(mStart, mStart + overlayBudget);
            return (
          <Box flexDirection="column" borderStyle={screenReader ? undefined : "single"} borderColor={screenReader ? undefined : T.borderActive} paddingX={1}>
            <Text bold={screenReader ? false : true} color={screenReader ? undefined : T.primary}>message selector (rewind)</Text>
            {!thread ? (
              <Text dimColor={!screenReader}>no thread yet</Text>
            ) : (
              <>
                {mVisible.map((r, i) => {
                  const gi = mStart + i;
                  const sel = gi === messageSelector.selected;
                  const padded = sel && !screenReader ? r + ' '.repeat(Math.max(0, columns - 4 - r.length)) : r;
                  return (
                  <Text key={gi} backgroundColor={screenReader ? undefined : (sel ? T.selectedBg : undefined)}>{padded}</Text>
                  );
                })}
                {runs.length === 0 ? <Text dimColor={!screenReader}>no runs to rewind to</Text> : null}
              </>
            )}
            <Text dimColor={!screenReader}>↑↓ navigate · Enter rewind · Esc close</Text>
          </Box>
            );
          })()
        ) : null}
        {permissionDialog ? (
          <PermissionDialog tool={permissionDialog.tool} input={permissionDialog.input} reason={permissionDialog.reason} rule={permissionDialog.rule} />
        ) : null}
        {settingsOpen ? (
          <Box flexDirection="column" paddingX={1}>
            <Box>
              <Text bold={screenReader ? false : true} color={screenReader ? undefined : T.primary}>Settings </Text>
              {(['status', 'config', 'usage', 'stats'] as const).map((t) => (
                <Text key={t} color={screenReader ? undefined : (t === settingsTab ? undefined : undefined)} backgroundColor={screenReader ? undefined : (t === settingsTab ? T.selectedBg : undefined)}> {t} </Text>
              ))}
            </Box>
            {settingsTab === 'status' ? (
              <Box flexDirection="column">
                {[
                  ['Model', model ?? 'auto'],
                  ['Permission', permission ?? 'auto'],
                  ['Thread', thread ?? 'new'],
                  ['Context', `${context} tokens`],
                  ['Spent', `$${spent.toFixed(4)}`],
                  ['Vim mode', vimMode],
                  ['State', running ? 'working' : 'idle'],
                ].map(([k, v]) => (
                  <Text key={k!}>
                    <Text>{k!.padEnd(11)}  </Text>
                    <Text dimColor={!screenReader}>{v}</Text>
                  </Text>
                ))}
              </Box>
            ) : null}
            {settingsTab === 'config' ? (
              <Box flexDirection="column">
                <Box borderStyle={screenReader ? undefined : 'round'} borderColor={screenReader ? undefined : T.border} paddingX={1}>
                  <Text dimColor={!screenReader}>{settingsQuery ? settingsQuery : '⌕ Search settings...'}</Text>
                </Box>
                {editingKey ? (
                  <Text>edit {humanizeSettingKey(editingKey)}: {editValue} (Enter saves · Esc cancels)</Text>
                ) : (() => {
                  try {
                    const raw = readSettings(join(cediaHome(), 'settings.json')) as Record<string, unknown>;
                    const q = settingsQuery.toLowerCase();
                    const keys = Object.keys(raw).filter((k) => !q || k.toLowerCase().includes(q));
                    if (!keys.length) return <Text dimColor={!screenReader}>no settings</Text>;
                    const sel = Math.min(configSelected, keys.length - 1);
                    const cStart = Math.max(0, Math.min(sel - overlayBudget + 2, Math.max(0, keys.length - overlayBudget)));
                    const cVisible = keys.slice(cStart, cStart + overlayBudget);
                    const labels = cVisible.map(humanizeSettingKey);
                    const w = Math.min(38, Math.max(...labels.map((l) => l.length)));
                    return (<>
                      {cStart > 0 ? <Text dimColor={!screenReader}>…{cStart} more above</Text> : null}
                      {cVisible.map((k, i) => {
                        const gi = cStart + i;
                        const v = raw[k];
                        const { text: shown } = settingDisplayValue(v);
                        const val = shown.length > 60 ? shown.slice(0, 59) + '…' : shown;
                        const isBool = typeof v === 'boolean';
                        return (
                          <Text key={k}>
                            <Text color={screenReader ? undefined : (gi === sel ? T.primary : undefined)}>{gi === sel ? '› ' : '  '}{labels[i]!.padEnd(w)}  </Text>
                            <Text
                              color={screenReader ? undefined : (isBool ? (v ? T.success : undefined) : (gi === sel ? T.primary : undefined))}
                              dimColor={screenReader ? false : (isBool ? !v : gi !== sel)}
                            >{val}</Text>
                          </Text>
                        );
                      })}
                      {cStart + cVisible.length < keys.length ? <Text dimColor={!screenReader}>…{keys.length - cStart - cVisible.length} more below</Text> : null}
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
                    {projectUsage.models.length ? projectUsage.models.slice(0, overlayBudget).map((m) => (
                      <Text key={m.model}>{m.model}: ${m.costUsd.toFixed(4)} · {m.requests} req</Text>
                    )) : <Text dimColor={!screenReader}>no priced requests yet</Text>}
                    {projectUsage.models.length > overlayBudget ? <Text dimColor={!screenReader}>…{projectUsage.models.length - overlayBudget} more</Text> : null}
                  </>
                ) : <Text dimColor={!screenReader}>no session logs yet</Text>}
              </Box>
            ) : null}
            {settingsTab === 'stats' ? (
              <Box flexDirection="column">
                {projectUsageStats ? (
                  <>
                    <Text>sessions: {projectUsageStats.sessions}</Text>
                    <Text>requests: {projectUsageStats.requests}</Text>
                    <Text>tokens: {projectUsageStats.tokens.in.toLocaleString()} in · {projectUsageStats.tokens.cache.toLocaleString()} cache read · {projectUsageStats.tokens.out.toLocaleString()} out</Text>
                    <Text>handoffs: {projectUsageStats.handoffs}</Text>
                  </>
                ) : <Text dimColor={!screenReader}>no session logs yet</Text>}
              </Box>
            ) : null}
            <Text dimColor={!screenReader}>{settingsTab === 'config' ? 'Enter/Space to change · / to search · ←/→ switch tabs · Esc to close' : '←/→ switch tabs · Esc to close'}</Text>
          </Box>
        ) : null}
        {suggestion ? <Text dimColor={!screenReader}>💡 {suggestion} (Tab to accept)</Text> : null}
        {mentionOpen ? (
          <Box flexDirection="column" paddingX={1}>
            {(() => {
              const maxRows = Math.max(3, Math.min(7, overlayBudget));
              const shown = mentionItems.slice(0, maxRows);
              return (<>
              {shown.map((it, i) => {
              const sel = i === Math.min(mentionSelected, mentionItems.length - 1);
              return (
                <Text key={`${it.name}::${i}`} wrap="truncate">
                  <Text color={screenReader ? undefined : (sel ? T.primary : undefined)}>{sel ? '› ' : '  '}</Text>
                  {highlightSpans(it.name, it.hits).map((sp, si) => (
                    <Text key={si} color={screenReader ? undefined : (sp.hit ? T.primary : undefined)} bold={screenReader ? false : sp.hit}>{sp.text}</Text>
                  ))}
                  <Text dimColor={!screenReader}>  file</Text>
                </Text>
              );
              })}
              {mentionItems.length > maxRows ? <Text dimColor={!screenReader}>  {mentionItems.length - maxRows} more…</Text> : null}
              </>);
            })()}
          </Box>
        ) : null}
        {autoOpen ? (
          <Box flexDirection="column" paddingX={1}>
            {(() => {
              const maxRows = Math.max(3, Math.min(7, overlayBudget));
              const shown = autoItems.slice(0, maxRows);
              return (<>
              {shown.map((it, i) => {
              const sel = i === Math.min(autoSelected, autoItems.length - 1);
              const maxDesc = Math.max(10, columns - it.name.length - 8);
              const plain = it.name.startsWith('/') ? it.name.slice(1) : it.name;
              return (
                <Text key={`${it.name}::${i}`} wrap="truncate">
                  <Text color={screenReader ? undefined : (sel ? T.primary : undefined)}>{sel ? '› ' : '  '}</Text>
                  {it.name.startsWith('/') ? <Text dimColor={!screenReader}>/</Text> : null}
                  {highlightSpans(plain, it.hits).map((sp, si) => (
                    <Text key={si} color={screenReader ? undefined : (sp.hit ? T.primary : undefined)} bold={screenReader ? false : sp.hit}>{sp.text}</Text>
                  ))}
                  <Text dimColor={!screenReader}>  {truncateDescription(it.description, maxDesc)}</Text>
                </Text>
              );
            })}
            {autoItems.length > maxRows ? <Text dimColor={!screenReader}>  {autoItems.length - maxRows} more…</Text> : null}
              </>);
            })()}
          </Box>
        ) : null}
        {notice ? (
          <Box justifyContent="flex-end" paddingX={1}>
            <Text color={screenReader ? undefined : T.warning}>{notice}</Text>
          </Box>
        ) : ((args.images?.length ?? 0) > 0 || effort) ? (
          <Box justifyContent="flex-end" paddingX={1}>
            <Text dimColor={!screenReader}>
              {(args.images ?? []).slice(0, 3).map((p) => `[Image ${(args.images ?? []).indexOf(p) + 1}]`).join(' ')}{effort ? `  ◐ ${effort}` : ''}
            </Text>
          </Box>
        ) : null}
        <Box paddingX={1}>
          <Text color={screenReader ? undefined : T.primary}>{screenReader ? '' : '› '}</Text>
          <VimInput value={input} onChange={setInput} onSubmit={submit} vimMode={vimMode} setVimMode={setVimMode} placeholder={INPUT_PLACEHOLDERS[new Date().getDate() % INPUT_PLACEHOLDERS.length]} captured={gate.captured} suppressSubmit={gate.suppressSubmit} />
        </Box>
        {effModel || effort ? (
          <Box paddingX={1}>
            <Text>
              {effModel ? <Text>{effModel.label}</Text> : null}
              {effModel?.provider ? <Text dimColor={!screenReader}> {effModel.provider}</Text> : null}
              {effort ? <Text color={screenReader ? undefined : T.warning}>  ◐ {effort}</Text> : null}
            </Text>
          </Box>
        ) : null}
        <StatusBar cwd={shortCwd(args.cwd)} tokens={context} windowSize={effModel?.window} spend={spent} vimMode={vimMode} activity={activity} running={running} hint="ctrl+p commands" />
        {statusLineOutput ? <Text dimColor={!screenReader}>{statusLineOutput}</Text> : null}
    </Box>
  );
}
