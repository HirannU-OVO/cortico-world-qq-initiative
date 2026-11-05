/**
 * QQ主动搭话 WebUI 后端调度与 Invoke 协议实现
 */
import {
  assembleWhitelist,
  maskToken,
  parseWhitelist,
  resolveOutboundTool,
  splitWhitelist,
  type ProactiveConfig,
} from '../config.ts';
import type { RoutineCoordinator } from '../engine/routine.ts';
import type { ActivityMonitor } from '../monitor/activity.ts';
import type { OutboundAdapter } from '../outbound/adapter.ts';
import { NudgeBuilder } from '../prompt/nudge_builder.ts';
import type { QuotaManager } from '../state/quota.ts';
import type { StateManager } from '../state/manager.ts';
import type { ProactiveScene, RoutinePhase, TargetKind } from '../types.ts';

export interface ProactivePanelContext {
  stateManager: StateManager;
  activityMonitor: ActivityMonitor;
  quotaManager: QuotaManager;
  routineCoordinator: RoutineCoordinator;
  outboundAdapter: OutboundAdapter;
  getConfig: () => ProactiveConfig;
  updateConfig?: (patch: Partial<ProactiveConfig>) => void;
  triggerProactive?: (address: string, scene: ProactiveScene, force?: boolean) => Promise<{ success: boolean; reason?: string }>;
}

export class ProactivePanelDispatcher {
  private ctx: ProactivePanelContext;

  constructor(ctx: ProactivePanelContext) {
    this.ctx = ctx;
  }

  async invoke(panel: string, method: string, args: unknown): Promise<unknown> {
    if (panel === 'dashboard') {
      return this.handleDashboard(method, args);
    }
    throw new Error(`未知的面板: ${panel}`);
  }

  private extractArg(args: unknown): Record<string, unknown> {
    if (Array.isArray(args)) {
      return (args[0] || {}) as Record<string, unknown>;
    }
    return (args || {}) as Record<string, unknown>;
  }

  private async handleDashboard(method: string, args: unknown): Promise<unknown> {
    const p = this.extractArg(args);
    const cfg = this.ctx.getConfig();

    switch (method) {
      case 'status': {
        const phase = this.ctx.routineCoordinator.getPhase(cfg);
        const sessions = this.ctx.stateManager.getAllSessions().map((s) => {
          const rawAddr = s.address;
          const isGroup = s.kind === 'group' || rawAddr.startsWith('group:');
          const id = rawAddr.replace(/^(private|group):/, '').replace(/\D/g, '') || rawAddr;
          let cleanLabel = (s.label || '').trim();
          if (
            !cleanLabel ||
            cleanLabel === rawAddr ||
            cleanLabel === id ||
            cleanLabel.startsWith('private:') ||
            cleanLabel.startsWith('group:')
          ) {
            cleanLabel = isGroup ? `群:${id}` : `QQ:${id}`;
          } else {
            const m = cleanLabel.match(/^(.+?)\s*\((?:QQ:)?\d+\)$/);
            if (m && m[1]) {
              cleanLabel = m[1].trim();
            }
          }
          const displayName = `${cleanLabel} (${rawAddr})`;

          return {
            address: s.address,
            kind: s.kind,
            label: cleanLabel,
            displayName,
            lastInboundAt: s.lastUserMessageTime ? new Date(s.lastUserMessageTime).toLocaleString('zh-CN') : '尚无记录',
            lastProactiveAt: s.lastProactiveSentTime ? new Date(s.lastProactiveSentTime).toLocaleString('zh-CN') : '尚无记录',
            unrepliedCount: s.unrepliedCount,
            isBlockedByUnreplied: s.unrepliedCount >= (cfg.unrepliedThreshold || 3),
          };
        });

        const phaseLabels: Record<RoutinePhase, string> = {
          WAKE: '清醒活跃期',
          NOON_LAZY: '午休惬意期',
          NIGHT_QUIET: '睡前放松期',
          SLEEP: '深睡休眠期（禁发）',
        };

        const whitelist = parseWhitelist(cfg);
        const split = splitWhitelist(whitelist);
        return {
          enabled: Boolean(cfg.enabled),
          mode: cfg.mode || 'private',
          whitelist,
          whitelistPrivateIds: split.privateIds,
          whitelistGroupIds: split.groupIds,
          whitelistPrivateText: split.privateText,
          whitelistGroupText: split.groupText,
          dailyCount: this.ctx.stateManager.dailyCount,
          dailyQuota: cfg.dailyQuota || 20,
          unrepliedThreshold: cfg.unrepliedThreshold || 3,
          outboundTool: resolveOutboundTool(cfg),
          outboundTokenMasked: maskToken(cfg.outboundHttpToken) || '（未配置）',
          routineEnabled: Boolean(cfg.routineEnabled),
          phase,
          phaseLabel: phaseLabels[phase] || phase,
          sleepRange: `${cfg.sleepStart} ~ ${cfg.sleepEnd}`,
          lazyRange: `${cfg.lazyStart} ~ ${cfg.lazyEnd}`,
          sessions,
        };
      }

      case 'update_whitelist': {
        const privateText = typeof p.privateText === 'string' ? p.privateText : '';
        const groupText = typeof p.groupText === 'string' ? p.groupText : '';
        const assembled = assembleWhitelist(privateText, groupText);

        // 只落 whitelistPrivate / whitelistGroup；merged 列表是派生缓存，不进配置文件
        cfg.whitelistPrivate = privateText;
        cfg.whitelistGroup = groupText;
        cfg.whitelist = assembled;
        if (this.ctx.updateConfig) {
          this.ctx.updateConfig({
            whitelistPrivate: privateText,
            whitelistGroup: groupText,
          });
        }

        const split = splitWhitelist(assembled);
        return {
          status: 'ok',
          message: `已保存：能主动找的私聊 ${split.privateIds.length} 个、群 ${split.groupIds.length} 个。`,
          whitelist: assembled,
          whitelistPrivateText: split.privateText,
          whitelistGroupText: split.groupText,
        };
      }

      case 'trigger_test': {
        const whitelist = parseWhitelist(cfg);
        let address = typeof p.address === 'string' && p.address.trim() ? p.address.trim() : whitelist[0] || '';
        if (/^\d+$/.test(address)) {
          address = `private:${address}`;
        }
        const scene = (p.scene as ProactiveScene) || 'idle_chat';
        const force = Boolean(p.force);
        const previewOnly = Boolean(p.previewOnly);

        const kind: TargetKind = address.startsWith('group:') ? 'group' : 'private';
        const phase = this.ctx.routineCoordinator.getPhase(cfg);

        // 准入判定：canTrigger(地址, 类型, 配置, 选项)，返回 { allowed, reason }
        const guard = this.ctx.quotaManager.canTrigger(address, kind, cfg, {
          force,
          dndActive: this.ctx.routineCoordinator.isDndActive(cfg),
        });
        if (!guard.allowed) {
          return {
            status: 'rejected',
            reason: guard.reason,
          };
        }

        // 仅预览模式：仅生成并返回搭话引导词，不唤醒桌宠与模型
        if (previewOnly) {
          const session = this.ctx.stateManager.getOrCreateSession(address, kind);
          const nudge = NudgeBuilder.build({
            session,
            scene,
            routinePhase: phase,
            outboundTool: this.ctx.outboundAdapter.toolName,
            withNickname: cfg.withNickname,
            allowSilence: cfg.allowSilence,
            silenceMinutes: Math.round(this.ctx.activityMonitor.getSilenceDurationMs(address) / 60_000),
          });

          return {
            status: 'preview',
            generatedNudge: nudge,
            message: '预览好了：下面这段就是它会收到的提示，没有真的叫醒它。',
          };
        }

        // 真实唤醒模式：调用 triggerProactive 下发真实任务
        if (this.ctx.triggerProactive) {
          const res = await this.ctx.triggerProactive(address, scene, force);
          if (!res.success) {
            return {
              status: 'rejected',
              reason: res.reason || '没能叫醒它，请稍后再试',
            };
          }
          const session = this.ctx.stateManager.getSession(address);
          const nudge = NudgeBuilder.build({
            session: session || this.ctx.stateManager.getOrCreateSession(address, kind),
            scene,
            routinePhase: phase,
            outboundTool: this.ctx.outboundAdapter.toolName,
            withNickname: cfg.withNickname,
            allowSilence: cfg.allowSilence,
            silenceMinutes: Math.round(this.ctx.activityMonitor.getSilenceDurationMs(address) / 60_000),
          });
          return {
            status: 'dispatched',
            message: `已开始：正在为 ${address} 组织一句主动的话。`,
            generatedNudge: nudge,
            activePledge: this.ctx.quotaManager.activePledge,
          };
        }

        // 兜底质押
        const pledged = this.ctx.quotaManager.pledge(
          address,
          kind,
          scene,
          this.ctx.outboundAdapter.toolName
        );

        const session = this.ctx.stateManager.getOrCreateSession(address, kind);
        const nudge = NudgeBuilder.build({
          session,
          scene,
          routinePhase: phase,
          outboundTool: this.ctx.outboundAdapter.toolName,
          withNickname: cfg.withNickname,
          allowSilence: cfg.allowSilence,
          silenceMinutes: Math.round(this.ctx.activityMonitor.getSilenceDurationMs(address) / 60_000),
        });

        return {
          status: 'pledged',
          pledged,
          generatedNudge: nudge,
          message: '已生成这次要说的话的提示草稿。',
        };
      }

      case 'reset_quota': {
        this.ctx.stateManager.resetDailyCount();
        return {
          status: 'ok',
          message: '已清零：今天算作还没主动说过话。',
          dailyCount: this.ctx.stateManager.dailyCount,
        };
      }

      case 'reset_session': {
        const address = typeof p.address === 'string' ? p.address.trim() : '';
        if (!address) {
          throw new Error('请提供要重置的会话地址 address');
        }
        const session = this.ctx.stateManager.getSession(address);
        const oldCount = session?.unrepliedCount || 0;
        this.ctx.stateManager.resetSession(address);

        if (oldCount === 0) {
          return {
            status: 'ok',
            message: `${address} 现在没有「连着没回」的记录，不用解锁。`,
            oldCount: 0,
          };
        }
        return {
          status: 'ok',
          message: `已解锁 ${address}：清掉了「连着 ${oldCount} 次没回」的记录，它能再主动找你了。`,
          oldCount,
        };
      }

      case 'reset_all': {
        this.ctx.stateManager.resetAll();
        return {
          status: 'ok',
          message: '已全部清零：所有对象的「没回」记录和今天的说话次数。',
        };
      }

      default:
        throw new Error(`未知的操作方法: ${method}`);
    }
  }
}
