import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cediaHome } from '../config.ts';

export type TeamTaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export type TeamTask = {
  id: string;
  title: string;
  status: TeamTaskStatus;
  assignee?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type Team = {
  id: string;
  name: string;
  createdAt: string;
  tasks: TeamTask[];
};

function teamsDir(home = cediaHome()): string {
  return join(home, 'teams');
}

function teamPath(id: string, home = cediaHome()): string {
  return join(teamsDir(home), `${id}.json`);
}

// Ids come from the model through the team tool, so only the shape newId makes names a file: "../settings" would
// read or rewrite a JSON file outside the teams directory.
const TEAM_ID = /^team-[a-z0-9]+-[a-z0-9]+$/;

function newId(): string {
  return `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function newTaskId(team: Team): string {
  return `t${team.tasks.length + 1}`;
}

export class TeamStore {
  constructor(private readonly home = cediaHome()) {
    mkdirSync(teamsDir(this.home), { recursive: true });
  }

  list(): Team[] {
    const dir = teamsDir(this.home);
    if (!existsSync(dir)) return [];
    const out: Team[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Team);
      } catch {
        // skip
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Team | undefined {
    if (!TEAM_ID.test(id)) return undefined;
    const p = teamPath(id, this.home);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as Team;
    } catch {
      return undefined;
    }
  }

  create(name: string): Team {
    const team: Team = { id: newId(), name, createdAt: new Date().toISOString(), tasks: [] };
    writeFileSync(teamPath(team.id, this.home), JSON.stringify(team, null, 2) + '\n');
    return team;
  }

  delete(id: string): boolean {
    if (!TEAM_ID.test(id)) return false;
    const p = teamPath(id, this.home);
    if (!existsSync(p)) return false;
    rmSync(p);
    return true;
  }

  addTask(id: string, title: string, assignee?: string): TeamTask | undefined {
    const team = this.get(id);
    if (!team) return undefined;
    const now = new Date().toISOString();
    const task: TeamTask = { id: newTaskId(team), title, status: 'pending', assignee, createdAt: now, updatedAt: now };
    team.tasks.push(task);
    writeFileSync(teamPath(id, this.home), JSON.stringify(team, null, 2) + '\n');
    return task;
  }

  updateTask(id: string, taskId: string, patch: Partial<Pick<TeamTask, 'status' | 'assignee' | 'notes' | 'title'>>): TeamTask | undefined {
    const team = this.get(id);
    if (!team) return undefined;
    const t = team.tasks.find((x) => x.id === taskId);
    if (!t) return undefined;
    if (patch.title !== undefined) t.title = patch.title;
    if (patch.status !== undefined) t.status = patch.status;
    if (patch.assignee !== undefined) t.assignee = patch.assignee;
    if (patch.notes !== undefined) t.notes = patch.notes;
    t.updatedAt = new Date().toISOString();
    writeFileSync(teamPath(id, this.home), JSON.stringify(team, null, 2) + '\n');
    return t;
  }

  removeTask(id: string, taskId: string): boolean {
    const team = this.get(id);
    if (!team) return false;
    const before = team.tasks.length;
    team.tasks = team.tasks.filter((x) => x.id !== taskId);
    if (team.tasks.length === before) return false;
    writeFileSync(teamPath(id, this.home), JSON.stringify(team, null, 2) + '\n');
    return true;
  }
}

export function teamLine(t: Team): string {
  const done = t.tasks.filter((x) => x.status === 'done').length;
  return `${t.id}  ${t.name}  [${done}/${t.tasks.length}]`;
}
