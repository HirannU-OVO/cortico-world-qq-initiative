/**
 * 通用活跃度监控与状态探测器（ActivityMonitor）
 * 包含 AstrBot 风格的执行期间新消息冲突熔断保护（Concurrency Guard）
 */
import type { SessionActivity, TargetKind } from '../types.ts';
import type { StateManager } from '../state/manager.ts';

export interface MessageObservedEvent {
  address: string;
  kind: TargetKind;
  isFromUser: boolean;
  label?: string;
  text?: string;
  ts?: number;
}

export class ActivityMonitor {
  private readonly stateManager: StateManager;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  /**
   * 记录外部消息或模型回复，更新活跃时间戳
   */
  observeMessage(event: MessageObservedEvent): void {
    const { address, kind, isFromUser, label, ts } = event;
    const now = ts || Date.now();

    const session = this.stateManager.getOrCreateSession(address, kind, label);

    this.stateManager.updateSession(address, (s) => {
      if (isFromUser) {
        s.lastUserMessageTime = now;
        // 用户发言后，立即清空之前的未回复计数，重获主动关怀资格
        s.unrepliedCount = 0;
      } else {
        s.lastBotMessageTime = now;
      }
      if (label && s.label !== label) {
        s.label = label;
      }
    });
  }

  /**
   * 获取指定会话当前活跃度视图
   */
  getSessionActivity(address: string): SessionActivity | undefined {
    return this.stateManager.getSession(address);
  }

  /**
   * 获取所有会话列表
   */
  getAllSessions(): SessionActivity[] {
    return Object.values(this.stateManager.data.sessions);
  }

  /**
   * 计算指定会话的静默时长（毫秒）
   * 取用户最后发言时间与 Bot 最后发言时间中的较大者
   */
  getSilenceDurationMs(address: string, now: number = Date.now()): number {
    const session = this.stateManager.getSession(address);
    if (!session) return Number.MAX_SAFE_INTEGER;
    const lastActive = Math.max(session.lastUserMessageTime || 0, session.lastBotMessageTime || 0);
    if (lastActive === 0) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, now - lastActive);
  }

  /**
   * 检查并发冲突（Concurrency Guard）：
   * 在主动回合执行完毕后调用。如果在此期间该会话收到了用户的新消息，则判定发生冲突，应丢弃主动搭话
   */
  hasUserSpokenSince(address: string, snapshotUserTime: number): boolean {
    const session = this.stateManager.getSession(address);
    if (!session) return false;
    return session.lastUserMessageTime > snapshotUserTime;
  }
}
