/**
 * cortico-world-qq-initiative 核心领域实体与接口契约
 */

export type TargetKind = 'private' | 'group';

export type RoutinePhase = 'WAKE' | 'NOON_LAZY' | 'NIGHT_QUIET' | 'SLEEP';

export type ProactiveScene =
  | 'idle_chat'
  | 'routine_wake'
  | 'routine_noon'
  | 'routine_sleep';

/**
 * 单个会话的活跃度与历史统计
 */
export interface SessionActivity {
  address: string;
  kind: TargetKind;
  label?: string;
  lastUserMessageTime: number;
  lastBotMessageTime: number;
  lastProactiveSentTime: number;
  unrepliedCount: number;
  nextScheduledTime?: number;
  recentTopics?: string[];
}

/**
 * 质押态信息（正在进行中的主动回合）
 * id 是这笔质押的唯一标识：结算与回滚都必须带 id，避免迟到回合误清新质押。
 */
export interface PledgedTurn {
  id: string;
  address: string;
  kind: TargetKind;
  label?: string;
  scene: ProactiveScene;
  pledgedAt: number;
  snapshotLastUserTime: number;
  outboundTool: string;
}

/**
 * 一次发信的真实回执
 * 由自建发信通道在真正调用 OneBot 接口后填充，成功语义来自平台返回而非「工具跑过」。
 */
export interface SendReceipt {
  ok: boolean;
  address: string;
  text: string;
  messageId?: string | number;
  error?: string;
  raw?: unknown;
}

/**
 * 审计日志项
 */
export interface ProactiveAuditLog {
  ts: string;
  target: string;
  event: 'pledged' | 'sent' | 'silence_rollback' | 'conflict_aborted' | 'error_rollback' | 'target_mismatch';
  summary: string;
}

/**
 * 持久化数据结构
 */
export interface ProactivePersistedState {
  version: number;
  date: string;
  dailyCount: number;
  lastRoutinePhase: RoutinePhase;
  sessions: Record<string, SessionActivity>;
  auditLog: ProactiveAuditLog[];
}

/**
 * 抽象发信契约
 */
export interface OutboundContract {
  toolName: string;
  toField: string;
  textField: string;
  channelPrefix?: string;
}

/**
 * 通用主动发起事件载荷元数据
 */
export interface ProactiveEventMeta {
  channel: string;
  targetAddress: string;
  targetKind: TargetKind;
  targetName?: string;
  unansweredCount: number;
  scene: ProactiveScene;
  outboundTool: string;
  forced: boolean;
}
