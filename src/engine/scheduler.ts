/**
 * 智能决策调度引擎（Scheduler）
 * 包含：
 * 1. AstrBot 风格的 [min, max] 随机区间扰动算法，打破机械固定时钟；
 * 2. 多维度加权打分挑选算法（Pick Scoring）：静默时长、未回复惩罚、白名单优先级。
 */
import { parseWhitelist, type ProactiveConfig } from '../config.ts';
import type { SessionActivity } from '../types.ts';
import type { ActivityMonitor } from '../monitor/activity.ts';
import type { QuotaManager, CanTriggerOptions } from '../state/quota.ts';
import { matchesAddress } from '../outbound/adapter.ts';

export interface CandidateScore {
  session: SessionActivity;
  score: number;
  silenceMinutes: number;
  reason: string;
}

export class Scheduler {
  private readonly activityMonitor: ActivityMonitor;
  private readonly quotaManager: QuotaManager;

  constructor(activityMonitor: ActivityMonitor, quotaManager: QuotaManager) {
    this.activityMonitor = activityMonitor;
    this.quotaManager = quotaManager;
  }

  /**
   * 生成指定范围内的随机间隔时间（毫秒）
   */
  getRandomIntervalMs(minMinutes: number, maxMinutes: number): number {
    const min = Math.max(1, minMinutes);
    const max = Math.max(min, maxMinutes);
    const selectedMinutes = min + Math.random() * (max - min);
    return Math.floor(selectedMinutes * 60 * 1000);
  }

  /**
   * 计算候选会话的综合加权打分
   * 评分因子：
   * - 静默时长（越久基础分越高，权重 0.4）
   * - 未回复惩罚（未回复次数越高，惩罚越严，避免紧追不舍）
   * - 白名单优先级（配置在白名单中的亲密好友，权重 0.3）
   */
  scoreCandidate(
    session: SessionActivity,
    cfg: ProactiveConfig,
    options: CanTriggerOptions = {},
    now: number = Date.now()
  ): CandidateScore | null {
    // 守卫检查（enabled / mode / 白名单 / DND / 在途 / 配额 / 未回复 / 最小区间）
    const guard = this.quotaManager.canTrigger(session.address, session.kind, cfg, options);
    if (!guard.allowed) {
      return null;
    }

    const silenceMs = this.activityMonitor.getSilenceDurationMs(session.address, now);
    const silenceMinutes = silenceMs / 60000;

    // 白名单硬排除（传整段配置：内部合并 whitelistPrivate / whitelistGroup）
    const whitelist = parseWhitelist(cfg);
    if (!whitelist.some((w) => matchesAddress(session.address, w))) {
      return null;
    }

    const minMinutes = session.kind === 'private' ? cfg.privateMinIntervalMin : cfg.groupMinIntervalMin;

    // 静默时长未达到配置的最小区间，不参与本次挑选
    if (silenceMinutes < minMinutes) {
      return null;
    }

    const safeMin = Math.max(1, minMinutes);
    // 1. 静默时长得分（对数增长，上限 100 分）
    const durationScore = Math.min(100, Math.log2(Math.max(1, silenceMinutes / safeMin) + 1) * 50);

    // 2. 未回复惩罚（每次未回复降 35 分）
    const penalty = (session.unrepliedCount || 0) * 35;

    // 3. 白名单亲密加分（用于白名单内部的多候选人加权排序）
    const whitelistBonus = 40;

    // 4. 随机扰动因子（0 ~ 15 分，模拟人类心绪波动）
    const jitter = Math.random() * 15;

    const totalScore = Math.max(0, durationScore * 0.4 + whitelistBonus * 0.3 + jitter - penalty);

    return {
      session,
      score: totalScore,
      silenceMinutes: Math.round(silenceMinutes),
      reason: `silence=${Math.round(silenceMinutes)}m, unreplied=${session.unrepliedCount}, bonus=${whitelistBonus}`,
    };
  }

  /**
   * 从所有已知会话中加权挑选最适宜主动关怀的目标
   */
  pickBestCandidate(
    cfg: ProactiveConfig,
    options: CanTriggerOptions = {},
    now: number = Date.now()
  ): CandidateScore | null {
    const sessions = this.activityMonitor.getAllSessions();
    if (!sessions.length) return null;

    const candidates: CandidateScore[] = [];

    for (const s of sessions) {
      // 派发冷却中：上一轮派发后还没到允许间隔，不参与本次挑选，
      // 避免模型静默时每隔一个 tick 就重派一次。
      if (s.nextScheduledTime && s.nextScheduledTime > now) continue;
      const sc = this.scoreCandidate(s, cfg, options, now);
      if (sc && sc.score > 0) {
        candidates.push(sc);
      }
    }

    if (!candidates.length) return null;

    candidates.sort((a, b) => b.score - a.score);

    return candidates[0];
  }
}
