/**
 * 配额守卫与三阶段事务自愈状态机（QuotaManager）
 * 包含：
 * 1. Pledged（质押态）：发起主动轮次前质押额度并创建快照锁，每笔质押带唯一 pledgeId；
 * 2. Verified（核销态）：自建发信通道拿到真实成功回执后，核销写入配额、未回复数与近期话题；
 * 3. Rolled Back（无损回滚态）：模型静默、异常超时或并发冲突时无损释放质押。
 */
import type { PledgedTurn, ProactiveScene, TargetKind } from '../types.ts';
import { parseWhitelist, type ProactiveConfig } from '../config.ts';
import type { StateManager } from '../state/manager.ts';
import type { ActivityMonitor } from '../monitor/activity.ts';
import { matchesAddress } from '../outbound/adapter.ts';

export interface QuotaGuardResult {
  allowed: boolean;
  reason?: string;
}

export interface CanTriggerOptions {
  /** 强制触发：只允许跳过「配额」与「最小区间」，不得跳过白名单 / DND / 未回复阈值。 */
  force?: boolean;
  /** 当前是否处于作息免打扰（SLEEP）时段。 */
  dndActive?: boolean;
}

const PLEDGE_TIMEOUT_MS = 180_000;

export class QuotaManager {
  private readonly stateManager: StateManager;
  private readonly activityMonitor: ActivityMonitor;
  private currentPledged: PledgedTurn | null = null;
  private pledgeSeq = 0;

  constructor(stateManager: StateManager, activityMonitor: ActivityMonitor) {
    this.stateManager = stateManager;
    this.activityMonitor = activityMonitor;
  }

  get activePledge(): Readonly<PledgedTurn> | null {
    return this.currentPledged;
  }

  /**
   * 准入判定，顺序固定为：
   * enabled → mode → 白名单硬排除 → DND → 在途质押 → 配额 → 未回复阈值 → 最小区间
   * force 只放宽配额与最小区间两项。
   */
  canTrigger(
    targetAddress: string,
    targetKind: TargetKind,
    cfg: ProactiveConfig,
    options: CanTriggerOptions = {}
  ): QuotaGuardResult {
    const force = options.force === true;

    if (!cfg.enabled) {
      return { allowed: false, reason: '主动搭话全局开关已关闭' };
    }

    if (cfg.mode !== 'all' && cfg.mode !== targetKind) {
      return { allowed: false, reason: `当前模式限制为 [${cfg.mode}]，会话类型为 [${targetKind}]` };
    }

    // 白名单硬排除：任何路径（含强制触发）都不得越界
    const whitelist = parseWhitelist(cfg);
    if (!whitelist.some((w) => matchesAddress(targetAddress, w))) {
      return { allowed: false, reason: `目标 ${targetAddress} 不在主动搭话白名单内` };
    }

    if (options.dndActive) {
      return { allowed: false, reason: '当前处于作息免打扰（深睡）时段，禁止任何主动发信' };
    }

    if (this.currentPledged) {
      const elapsed = Date.now() - this.currentPledged.pledgedAt;
      if (elapsed > PLEDGE_TIMEOUT_MS) {
        // 僵死质押先行自愈：按 id 精确回滚，不影响期间可能新建的质押
        this.rollbackPledge('previous_pledge_timeout', this.currentPledged.id);
      } else {
        return {
          allowed: false,
          reason: `已有在途的主动质押任务 (${this.currentPledged.address}) 正在执行中`,
        };
      }
    }

    if (!force && cfg.dailyQuota > 0 && this.stateManager.dailyCount >= cfg.dailyQuota) {
      return { allowed: false, reason: `已达今日主动发言配额上限 (${this.stateManager.dailyCount}/${cfg.dailyQuota})` };
    }

    const session = this.stateManager.getSession(targetAddress);
    if (session && cfg.unrepliedThreshold > 0 && session.unrepliedCount >= cfg.unrepliedThreshold) {
      return {
        allowed: false,
        reason: `该会话连续未回复已达上限 (${session.unrepliedCount}/${cfg.unrepliedThreshold})，暂停打扰`,
      };
    }

    if (!force && session && session.lastProactiveSentTime > 0) {
      const minIntervalMin = targetKind === 'private' ? cfg.privateMinIntervalMin : cfg.groupMinIntervalMin;
      const elapsedMin = (Date.now() - session.lastProactiveSentTime) / 60_000;
      if (elapsedMin < Math.max(1, minIntervalMin)) {
        return {
          allowed: false,
          reason: `同会话最小区间未满 (${Math.floor(elapsedMin)}/${minIntervalMin} 分钟)`,
        };
      }
    }

    // 派发冷却：上一轮派发后还没到允许间隔（含模型选择安静的情况）。
    // force 会跳过它——强制触发就是用来无视这些限制的。
    if (!force && session && session.nextScheduledTime && session.nextScheduledTime > Date.now()) {
      const remainMin = Math.ceil((session.nextScheduledTime - Date.now()) / 60_000);
      return {
        allowed: false,
        reason: `该会话还在主动搭话冷却中（还需等待 ${remainMin} 分钟）`,
      };
    }

    return { allowed: true };
  }

  /**
   * 阶段一：意图质押（Pledge）
   * 只登记在途状态与用户最后发言时间快照，不扣减实际配额与未回复计数。
   */
  pledge(
    address: string,
    kind: TargetKind,
    scene: ProactiveScene,
    outboundTool: string,
    label?: string
  ): PledgedTurn {
    const session = this.stateManager.getOrCreateSession(address, kind, label);
    const snapshotUserTime = session.lastUserMessageTime || 0;
    this.pledgeSeq += 1;

    const pledged: PledgedTurn = {
      id: `p-${Date.now()}-${this.pledgeSeq}`,
      address,
      kind,
      label,
      scene,
      pledgedAt: Date.now(),
      snapshotLastUserTime: snapshotUserTime,
      outboundTool,
    };

    this.currentPledged = pledged;
    this.stateManager.addAuditLog({
      target: address,
      event: 'pledged',
      summary: `质押主动搭话任务 (id=${pledged.id}, scene=${scene}, snapshotUserTime=${snapshotUserTime})`,
    });

    return pledged;
  }

  /** 判断一笔质押是否仍是当前在途的那一笔。 */
  isActivePledge(pledgeId: string | undefined): boolean {
    if (!pledgeId || !this.currentPledged) return false;
    return this.currentPledged.id === pledgeId;
  }

  /**
   * 阶段二：真实核销（Verify）
   * 仅在自建发信通道拿到平台成功回执后调用：扣每日配额、未回复数 +1、写入近期话题。
   */
  verifyOutboundSent(targetAddress: string, sentText: string = '', pledgeId?: string): boolean {
    const pledged = this.currentPledged;
    if (!pledged) return false;

    if (pledgeId && pledged.id !== pledgeId) {
      this.stateManager.addAuditLog({
        target: pledged.address,
        event: 'error_rollback',
        summary: `迟到结算被丢弃：回执属于质押 ${pledgeId}，当前在途为 ${pledged.id}`,
      });
      return false;
    }

    const now = Date.now();

    if (targetAddress && !matchesAddress(targetAddress, pledged.address)) {
      this.stateManager.addAuditLog({
        target: pledged.address,
        event: 'target_mismatch',
        summary: `发信目标与质押目标不一致（期望 ${pledged.address}，实际 ${targetAddress}）`,
      });
      // 实际接收方只记录活跃时间，配额不记账
      this.stateManager.updateSession(targetAddress, (s) => {
        s.lastBotMessageTime = now;
      });
      this.currentPledged = null;
      return false;
    }

    if (this.activityMonitor.hasUserSpokenSince(pledged.address, pledged.snapshotLastUserTime)) {
      this.stateManager.addAuditLog({
        target: pledged.address,
        event: 'conflict_aborted',
        summary: '生成期间检测到用户发送了新消息，主动搭话安全熔断作废',
      });
      this.currentPledged = null;
      return false;
    }

    const dailyCount = this.stateManager.incrementDailyCount();
    this.stateManager.updateSession(pledged.address, (s) => {
      s.lastProactiveSentTime = now;
      s.lastBotMessageTime = now;
      s.unrepliedCount += 1;
      if (sentText) {
        const topicSummary = sentText.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 30);
        if (!s.recentTopics) s.recentTopics = [];
        s.recentTopics.push(topicSummary);
        if (s.recentTopics.length > 5) {
          s.recentTopics = s.recentTopics.slice(-5);
        }
      }
    });

    const summaryText = sentText ? sentText.replace(/[\r\n\t]+/g, ' ').slice(0, 30) : '已发信';
    this.stateManager.addAuditLog({
      target: pledged.address,
      event: 'sent',
      summary: `主动搭话核销成功：今日累计 ${dailyCount} 次，未回复阶梯更新。内容摘要: ${summaryText}`,
    });

    this.currentPledged = null;
    return true;
  }

  /**
   * 阶段三：无损安全回滚（Rollback）
   * 模型判定不打扰、发信未拿到成功回执、事件被丢弃或超时自愈时调用：配额无损、未回复数不增。
   */
  rollbackPledge(reason: string, pledgeId?: string): void {
    const pledged = this.currentPledged;
    if (!pledged) return;

    if (pledgeId && pledged.id !== pledgeId) {
      this.stateManager.addAuditLog({
        target: pledged.address,
        event: 'error_rollback',
        summary: `迟到回滚被丢弃：目标质押 ${pledgeId}，当前在途为 ${pledged.id}`,
      });
      return;
    }

    this.stateManager.addAuditLog({
      target: pledged.address,
      event: reason === 'conflict_aborted' ? 'conflict_aborted' : 'silence_rollback',
      summary: `主动搭话已无损安全回滚：原因=${reason}`,
    });

    this.currentPledged = null;
  }
}
