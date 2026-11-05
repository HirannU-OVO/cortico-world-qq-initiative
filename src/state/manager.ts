/**
 * 原子化持久化存储与状态生命周期管理
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ProactivePersistedState, RoutinePhase, SessionActivity } from '../types.ts';

export function getTodayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function createInitialState(dateStr: string = getTodayDateString()): ProactivePersistedState {
  return {
    version: 1,
    date: dateStr,
    dailyCount: 0,
    lastRoutinePhase: 'WAKE',
    sessions: {},
    auditLog: [],
  };
}

export class StateManager {
  private readonly filePath: string;
  private state: ProactivePersistedState;

  constructor(storageDir: string) {
    this.filePath = resolve(storageDir, 'qq-initiative-v2.json');
    this.state = this.load();
  }

  get data(): Readonly<ProactivePersistedState> {
    this.checkDailyRollover();
    return this.state;
  }

  get dailyCount(): number {
    this.checkDailyRollover();
    return this.state.dailyCount;
  }

  get lastRoutinePhase(): RoutinePhase {
    return this.state.lastRoutinePhase;
  }

  setLastRoutinePhase(phase: RoutinePhase): void {
    this.state.lastRoutinePhase = phase;
    this.save();
  }

  getSession(address: string): SessionActivity | undefined {
    this.checkDailyRollover();
    return this.state.sessions[address];
  }

  getAllSessions(): SessionActivity[] {
    this.checkDailyRollover();
    return Object.values(this.state.sessions);
  }

  getOrCreateSession(address: string, kind: 'private' | 'group', label?: string): SessionActivity {
    this.checkDailyRollover();
    let session = this.state.sessions[address];
    if (!session) {
      session = {
        address,
        kind,
        label,
        lastUserMessageTime: 0,
        lastBotMessageTime: 0,
        lastProactiveSentTime: 0,
        unrepliedCount: 0,
        recentTopics: [],
      };
      this.state.sessions[address] = session;
      this.save();
    } else if (label && session.label !== label) {
      session.label = label;
      this.save();
    }
    return session;
  }

  updateSession(address: string, updater: (session: SessionActivity) => void): SessionActivity | undefined {
    const session = this.state.sessions[address];
    if (!session) return undefined;
    updater(session);
    this.save();
    return session;
  }

  incrementDailyCount(): number {
    this.checkDailyRollover();
    this.state.dailyCount += 1;
    this.save();
    return this.state.dailyCount;
  }

  resetDailyCount(): void {
    this.state.dailyCount = 0;
    this.save();
  }

  resetSession(address: string): boolean {
    this.checkDailyRollover();
    const session = this.state.sessions[address];
    if (!session) return false;
    session.unrepliedCount = 0;
    session.lastProactiveSentTime = 0;
    this.save();
    return true;
  }

  resetAll(): void {
    this.checkDailyRollover();
    this.state.dailyCount = 0;
    for (const key of Object.keys(this.state.sessions)) {
      this.state.sessions[key].unrepliedCount = 0;
      this.state.sessions[key].lastProactiveSentTime = 0;
    }
    this.save();
  }

  addAuditLog(log: {
    target: string;
    event: 'pledged' | 'sent' | 'silence_rollback' | 'conflict_aborted' | 'error_rollback' | 'target_mismatch';
    summary: string;
  }): void {
    const entry = {
      ts: new Date().toISOString(),
      ...log,
    };
    this.state.auditLog.push(entry);
    // 只保留最近 200 条审计日志
    if (this.state.auditLog.length > 200) {
      this.state.auditLog = this.state.auditLog.slice(-200);
    }
    this.save();
  }

  /**
   * 跨天原子化自动重置每日配额计数
   */
  private checkDailyRollover(): void {
    const today = getTodayDateString();
    if (this.state.date !== today) {
      this.state.date = today;
      this.state.dailyCount = 0;
      this.save();
    }
  }

  private load(): ProactivePersistedState {
    if (!existsSync(this.filePath)) {
      const initial = createInitialState();
      this.saveDirect(initial);
      return initial;
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as ProactivePersistedState;
      if (!parsed || typeof parsed !== 'object' || !parsed.sessions) {
        throw new Error('Invalid state structure');
      }
      return parsed;
    } catch {
      // 容灾恢复：若文件损坏，自动备份并恢复初始值
      const backupPath = `${this.filePath}.corrupted.${Date.now()}`;
      try {
        renameSync(this.filePath, backupPath);
      } catch {}
      const fallback = createInitialState();
      this.saveDirect(fallback);
      return fallback;
    }
  }

  private save(): void {
    this.saveDirect(this.state);
  }

  private saveDirect(state: ProactivePersistedState): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${this.filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    const json = JSON.stringify(state, null, 2);
    writeFileSync(tempPath, json, 'utf-8');
    renameSync(tempPath, this.filePath);
  }
}
