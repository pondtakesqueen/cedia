import type { SearchSource } from "./websearch.ts";

export interface QueryTerm {
  text: string;
  phrase?: boolean;
  negated?: boolean;
  group?: number;
}

export interface StructuredQuery {
  raw: string;
  text: string;
  terms: QueryTerm[];
  sites: string[];
  excludedSites: string[];
  inUrl: string[];
  excludedInUrl: string[];
  inTitle: string[];
  excludedInTitle: string[];
  inText: string[];
  excludedInText: string[];
  filetypes: string[];
  excludedFiletypes: string[];
  after?: string;
  before?: string;
  lang?: string;
  hasDirectives: boolean;
  hasConstraints: boolean;
}

export type ParsedQuery = StructuredQuery;

export interface QuerySyntax {
  phrases?: boolean;
  negation?: boolean;
  or?: boolean;
  site?: boolean;
  inUrl?: boolean;
  inTitle?: boolean;
  inText?: boolean;
  filetype?: boolean;
  dateRange?: boolean;
}

export interface ConstraintFilterResult {
  sources: SearchSource[];
  dropped: string[];
}

const DIRECTIVE_PATTERN = /^([+-]?)([a-z][a-z-]*):(.*)$/i;
const WHITESPACE = /\s/;

interface RawToken {
  text: string;
  quoted: boolean;
  quotedValue?: boolean;
}

function isQuote(ch: string): boolean {
  return ch === '"' || ch === "\u201c" || ch === "\u201d";
}

function tokenize(raw: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (WHITESPACE.test(ch)) {
      i++;
      continue;
    }
    if (isQuote(ch)) {
      let j = i + 1;
      let buf = "";
      while (j < raw.length && !isQuote(raw[j])) {
        buf += raw[j];
        j++;
      }
      if (buf.trim().length > 0) tokens.push({ text: buf.trim(), quoted: true });
      i = j + 1;
      continue;
    }
    let buf = "";
    let quotedValue = false;
    while (i < raw.length && !WHITESPACE.test(raw[i])) {
      const c = raw[i];
      if (isQuote(c) && buf.endsWith(":")) {
        let j = i + 1;
        while (j < raw.length && !isQuote(raw[j])) {
          buf += raw[j];
          j++;
        }
        quotedValue = true;
        i = j + 1;
        continue;
      }
      if (isQuote(c)) break;
      buf += c;
      i++;
    }
    if (buf.length > 0) tokens.push({ text: buf, quoted: false, quotedValue });
  }
  return splitParens(tokens);
}

function splitParens(tokens: RawToken[]): RawToken[] {
  const out: RawToken[] = [];
  for (const tok of tokens) {
    if (tok.quoted || tok.quotedValue) {
      out.push(tok);
      continue;
    }
    let text = tok.text;
    while (text.startsWith("(")) {
      out.push({ text: "(", quoted: false });
      text = text.slice(1);
    }
    let trailing = 0;
    while (text.endsWith(")")) {
      const body = text.slice(0, -1);
      let depth = 0;
      for (const c of body) {
        if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      if (depth > 0) break;
      text = body;
      trailing++;
    }
    if (text.length > 0) out.push({ text, quoted: false });
    for (let k = 0; k < trailing; k++) out.push({ text: ")", quoted: false });
  }
  return out;
}

function isoDate(year: number, month: number, day: number): string | undefined {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseDateValue(value: string): string | undefined {
  const t = value.trim();
  let m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(t);
  if (m) return isoDate(Number(m[1]), m[2] ? Number(m[2]) : 1, m[3] ? Number(m[3]) : 1);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) {
    let month = Number(m[1]);
    let day = Number(m[2]);
    if (month > 12 && day <= 12) {
      const swap = month;
      month = day;
      day = swap;
    }
    return isoDate(Number(m[3]), month, day);
  }
  return undefined;
}

function normalizeSite(value: string): string {
  let site = value.trim().toLowerCase();
  site = site.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  if (site.startsWith("*.")) site = site.slice(2);
  site = site.replace(/[/.]+$/, "");
  return site;
}

const DIRECTIVE_FIELDS: Record<string, "site" | "inUrl" | "inTitle" | "inText" | "filetype" | "before" | "after" | "lang"> = {
  site: "site",
  domain: "site",
  host: "site",
  inurl: "inUrl",
  url: "inUrl",
  intitle: "inTitle",
  title: "inTitle",
  intext: "inText",
  inbody: "inText",
  inanchor: "inText",
  filetype: "filetype",
  ext: "filetype",
  before: "before",
  until: "before",
  after: "after",
  since: "after",
  lang: "lang",
  language: "lang",
};

const ALL_MODES: Record<string, "inTitle" | "inUrl" | "inText"> = {
  allintitle: "inTitle",
  allinurl: "inUrl",
  allintext: "inText",
};

function isReservedToken(text: string): boolean {
  if (text === "(" || text === ")" || text === "OR" || text === "AND" || text === "NOT" || text === "|" || text === "||" || text === "&&" || text === "!") return true;
  const m = DIRECTIVE_PATTERN.exec(text);
  if (!m) return false;
  const name = m[2].toLowerCase();
  return DIRECTIVE_FIELDS[name] !== undefined || ALL_MODES[name] !== undefined;
}

export function parseSearchQuery(raw: string): StructuredQuery {
  const q: StructuredQuery = {
    raw,
    text: "",
    terms: [],
    sites: [],
    excludedSites: [],
    inUrl: [],
    excludedInUrl: [],
    inTitle: [],
    excludedInTitle: [],
    inText: [],
    excludedInText: [],
    filetypes: [],
    excludedFiletypes: [],
    hasDirectives: false,
    hasConstraints: false,
  };

  const tokens = tokenize(raw);
  let negateNext = false;
  let orPending = false;
  let lastWasTerm = false;
  let groupSeq = 0;
  let allMode: "inTitle" | "inUrl" | "inText" | undefined;

  const pushConstraint = (field: "site" | "inUrl" | "inTitle" | "inText" | "filetype", value: string, negated: boolean): void => {
    q.hasDirectives = true;
    orPending = false;
    lastWasTerm = false;
    const v = value.trim();
    if (!v) return;
    if (field === "site") {
      const site = normalizeSite(v);
      if (site) (negated ? q.excludedSites : q.sites).push(site);
    } else if (field === "inUrl") {
      (negated ? q.excludedInUrl : q.inUrl).push(v);
    } else if (field === "inTitle") {
      (negated ? q.excludedInTitle : q.inTitle).push(v);
    } else if (field === "inText") {
      (negated ? q.excludedInText : q.inText).push(v);
    } else {
      const ext = v.toLowerCase().replace(/^\.+/, "");
      if (ext) (negated ? q.excludedFiletypes : q.filetypes).push(ext);
    }
  };

  const pushTerm = (text: string, phrase: boolean): void => {
    const negated = negateNext;
    negateNext = false;
    if (allMode) {
      pushConstraint(allMode, text, negated);
      return;
    }
    const term: QueryTerm = { text };
    if (phrase) term.phrase = true;
    if (negated) term.negated = true;
    if (orPending && lastWasTerm) {
      const prev = q.terms[q.terms.length - 1];
      if (prev) {
        if (prev.group === undefined) prev.group = ++groupSeq;
        term.group = prev.group;
      }
    }
    orPending = false;
    lastWasTerm = true;
    q.terms.push(term);
  };

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok.quoted) {
      pushTerm(tok.text, true);
      continue;
    }
    if (tok.text === "(" || tok.text === ")") continue;
    if (tok.text === "OR" || tok.text === "|" || tok.text === "||") {
      orPending = true;
      q.hasDirectives = true;
      continue;
    }
    if (tok.text === "AND" || tok.text === "&&") {
      q.hasDirectives = true;
      continue;
    }
    if (tok.text === "NOT" || tok.text === "!") {
      negateNext = true;
      q.hasDirectives = true;
      continue;
    }
    if (tok.text === "-" || tok.text === "+") {
      if (tok.text === "-" && tokens[idx + 1]?.quoted) negateNext = true;
      continue;
    }

    const match = DIRECTIVE_PATTERN.exec(tok.text);
    const name = match?.[2].toLowerCase();
    const allMatch = name ? ALL_MODES[name] : undefined;
    const field = name ? DIRECTIVE_FIELDS[name] : undefined;

    if (match && allMatch) {
      allMode = allMatch;
      q.hasDirectives = true;
      const inline = match[3].trim();
      if (inline) pushConstraint(allMatch, inline, match[1] === "-");
      orPending = false;
      lastWasTerm = false;
      continue;
    }

    if (match && field) {
      let value = match[3].trim();
      if (!value) {
        const next = tokens[idx + 1];
        if (next && (next.quoted || !isReservedToken(next.text))) {
          value = next.text.trim();
          idx++;
        }
      }
      if (!value) {
        q.hasDirectives = true;
        continue;
      }
      const negated = match[1] === "-" || negateNext;
      negateNext = false;
      if (field === "before" || field === "after") {
        const iso = parseDateValue(value);
        if (!iso) {
          pushTerm(tok.text, false);
          continue;
        }
        if (field === "before") q.before = iso;
        else q.after = iso;
        q.hasDirectives = true;
        orPending = false;
        lastWasTerm = false;
      } else if (field === "lang") {
        q.lang = value.toLowerCase();
        q.hasDirectives = true;
        orPending = false;
        lastWasTerm = false;
      } else {
        pushConstraint(field, value, negated);
      }
      continue;
    }

    let text = tok.text;
    if (text.startsWith("-") && text.length > 1) {
      negateNext = true;
      q.hasDirectives = true;
      text = text.replace(/^-+/, "");
      if (!text) continue;
      const negMatch = DIRECTIVE_PATTERN.exec(text);
      const negName = negMatch?.[2].toLowerCase();
      const negField = negName ? DIRECTIVE_FIELDS[negName] : undefined;
      if (negMatch && negField && negField !== "before" && negField !== "after" && negField !== "lang") {
        negateNext = false;
        pushConstraint(negField, negMatch[3].trim(), true);
        continue;
      }
      pushTerm(text, false);
      continue;
    }
    if (text.startsWith("+") && text.length > 1) {
      pushTerm(text.slice(1), true);
      q.hasDirectives = true;
      continue;
    }
    pushTerm(text, false);
  }

  q.text = renderTerms(q.terms, { phrases: true, negation: true, or: true });
  q.hasConstraints =
    q.sites.length > 0 ||
    q.excludedSites.length > 0 ||
    q.inUrl.length > 0 ||
    q.excludedInUrl.length > 0 ||
    q.inTitle.length > 0 ||
    q.excludedInTitle.length > 0 ||
    q.filetypes.length > 0 ||
    q.excludedFiletypes.length > 0 ||
    q.before !== undefined ||
    q.after !== undefined;
  return q;
}

function quoteValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function renderTerm(term: QueryTerm, syntax: QuerySyntax): string | undefined {
  if (term.negated && !syntax.negation) return undefined;
  const body = term.phrase && syntax.phrases ? `"${term.text}"` : term.text;
  return term.negated ? `-${body}` : body;
}

function renderTerms(terms: readonly QueryTerm[], syntax: QuerySyntax): string {
  const parts: string[] = [];
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (term.group !== undefined && syntax.or) {
      const members: string[] = [];
      let j = i;
      for (; j < terms.length && terms[j].group === term.group; j++) {
        const rendered = renderTerm(terms[j], syntax);
        if (rendered) members.push(rendered);
      }
      i = j - 1;
      if (members.length > 1) parts.push(`(${members.join(" OR ")})`);
      else if (members.length === 1) parts.push(members[0]);
      continue;
    }
    const rendered = renderTerm(term, syntax);
    if (rendered) parts.push(rendered);
  }
  return parts.join(" ");
}

export function formatQuery(q: StructuredQuery, syntax: QuerySyntax = {}): string {
  const parts: string[] = [];
  const text = renderTerms(q.terms, syntax);
  if (text) parts.push(text);
  if (syntax.site) {
    if (q.sites.length > 1 && syntax.or) parts.push(`(${q.sites.map((s) => `site:${s}`).join(" OR ")})`);
    else parts.push(...q.sites.map((s) => `site:${s}`));
    parts.push(...q.excludedSites.map((s) => `-site:${s}`));
  }
  if (syntax.inUrl) {
    parts.push(...q.inUrl.map((v) => `inurl:${quoteValue(v)}`));
    parts.push(...q.excludedInUrl.map((v) => `-inurl:${quoteValue(v)}`));
  }
  if (syntax.inTitle) {
    parts.push(...q.inTitle.map((v) => `intitle:${quoteValue(v)}`));
    parts.push(...q.excludedInTitle.map((v) => `-intitle:${quoteValue(v)}`));
  }
  if (syntax.inText) {
    parts.push(...q.inText.map((v) => `intext:${quoteValue(v)}`));
    parts.push(...q.excludedInText.map((v) => `-intext:${quoteValue(v)}`));
  }
  if (syntax.filetype) {
    if (q.filetypes.length > 1 && syntax.or) parts.push(`(${q.filetypes.map((f) => `filetype:${f}`).join(" OR ")})`);
    else parts.push(...q.filetypes.map((f) => `filetype:${f}`));
    parts.push(...q.excludedFiletypes.map((f) => `-filetype:${f}`));
  }
  if (syntax.dateRange) {
    if (q.after) parts.push(`after:${q.after}`);
    if (q.before) parts.push(`before:${q.before}`);
  }

  let result = parts.join(" ").trim();
  if (!result) {
    result = [...q.sites, ...q.inTitle, ...q.inUrl, ...q.inText, ...q.filetypes].join(" ").trim();
  }
  return result || q.raw.trim();
}

export const GOOGLE_QUERY_SYNTAX: QuerySyntax = {
  phrases: true,
  negation: true,
  or: true,
  site: true,
  inUrl: true,
  inTitle: true,
  inText: true,
  filetype: true,
  dateRange: true,
};

export function formatScraperQuery(query: string, parsed?: StructuredQuery, syntax: QuerySyntax = GOOGLE_QUERY_SYNTAX): string {
  const p = parsed ?? parseSearchQuery(query);
  if (!p.hasDirectives) return query;
  const demoted = [...p.sites.filter((s) => s.includes("/")), ...p.inUrl];
  const downgraded: StructuredQuery = {
    ...p,
    sites: p.sites.filter((s) => !s.includes("/")),
    inUrl: [],
    terms: [...p.terms, ...demoted.map((text) => ({ text }))],
  };
  return formatQuery(downgraded, syntax);
}

function hostAndPath(url: string): { host: string; path: string } | undefined {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return undefined;
  }
}

export function matchesSite(url: string, site: string): boolean {
  const parsed = hostAndPath(url);
  if (!parsed) return false;
  const slash = site.indexOf("/");
  const siteHost = slash === -1 ? site : site.slice(0, slash);
  const sitePath = slash === -1 ? "" : site.slice(slash);
  if (parsed.host !== siteHost && !parsed.host.endsWith(`.${siteHost}`)) return false;
  if (sitePath && !parsed.path.toLowerCase().startsWith(sitePath.toLowerCase())) return false;
  return true;
}

function matchesFiletype(url: string, ext: string): boolean {
  const parsed = hostAndPath(url);
  if (!parsed) return false;
  return parsed.path.toLowerCase().endsWith(`.${ext}`);
}

interface ConstraintDimension {
  label: string;
  pred: (source: SearchSource) => boolean;
}

function constraintDimensions(q: StructuredQuery): ConstraintDimension[] {
  const dims: ConstraintDimension[] = [];
  const lower = (s: string | undefined): string => (s ?? "").toLowerCase();
  if (q.sites.length > 0) {
    dims.push({ label: q.sites.map((s) => `site:${s}`).join(" OR "), pred: (src) => q.sites.some((site) => matchesSite(src.url, site)) });
  }
  if (q.excludedSites.length > 0) {
    dims.push({ label: q.excludedSites.map((s) => `-site:${s}`).join(" "), pred: (src) => !q.excludedSites.some((site) => matchesSite(src.url, site)) });
  }
  if (q.inUrl.length > 0) {
    dims.push({ label: q.inUrl.map((v) => `inurl:${v}`).join(" "), pred: (src) => q.inUrl.every((v) => lower(src.url).includes(v.toLowerCase())) });
  }
  if (q.excludedInUrl.length > 0) {
    dims.push({ label: q.excludedInUrl.map((v) => `-inurl:${v}`).join(" "), pred: (src) => !q.excludedInUrl.some((v) => lower(src.url).includes(v.toLowerCase())) });
  }
  if (q.inTitle.length > 0) {
    dims.push({ label: q.inTitle.map((v) => `intitle:${v}`).join(" "), pred: (src) => q.inTitle.every((v) => lower(src.title).includes(v.toLowerCase())) });
  }
  if (q.excludedInTitle.length > 0) {
    dims.push({ label: q.excludedInTitle.map((v) => `-intitle:${v}`).join(" "), pred: (src) => !q.excludedInTitle.some((v) => lower(src.title).includes(v.toLowerCase())) });
  }
  if (q.filetypes.length > 0) {
    dims.push({ label: q.filetypes.map((f) => `filetype:${f}`).join(" OR "), pred: (src) => q.filetypes.some((ext) => matchesFiletype(src.url, ext)) });
  }
  if (q.excludedFiletypes.length > 0) {
    dims.push({ label: q.excludedFiletypes.map((f) => `-filetype:${f}`).join(" "), pred: (src) => !q.excludedFiletypes.some((ext) => matchesFiletype(src.url, ext)) });
  }
  return dims;
}

export function matchesQueryConstraints(source: SearchSource, q: StructuredQuery): boolean {
  for (const dim of constraintDimensions(q)) {
    if (!dim.pred(source)) return false;
  }
  return true;
}

export function applyQueryConstraints(sources: readonly SearchSource[], q: StructuredQuery): ConstraintFilterResult {
  let current = [...sources];
  const dropped: string[] = [];
  if (current.length === 0) return { sources: current, dropped };
  for (const dim of constraintDimensions(q)) {
    const kept = current.filter(dim.pred);
    if (kept.length > 0) current = kept;
    else dropped.push(dim.label);
  }
  return { sources: current, dropped };
}
