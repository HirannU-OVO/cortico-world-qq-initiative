/**
 * cortico-world-qq-initiative 主入口与 WorldDefinition 装配
 *
 * 设计要点（对应方案第九章整改）：
 * - Core 的 World 契约里没有 tick / onEvent：调度周期由 start() 自建的定时器驱动，
 *   入站消息经 host.store 游标增量拉取，绝不实现契约外的方法；
 * - 发信走自建 qq_initiative_send 工具，成功语义来自 OneBot 真实回执，而不是「工具跑过」；
 * - 质押带 pledgeId 与回合归属，只有真正投递的那一轮结束才结算。
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, RunPhase, ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { WorldContext, WorldDefinition } from 'cortico/world.ts';

import {
  PROACTIVE_DEFAULTS,
  PROACTIVE_DEFAULT_PROMPT,
  PROACTIVE_DEFAULT_PROMPT_FORCED,
  PROACTIVE_WORLD_ID,
  PROACTIVE_WORLD_LABEL,
  parseWhitelist,
  maskToken,
  proactiveConfigGroups,
  resolveOutboundTool,
  type ProactiveConfig,
} from './config.ts';
import { StateManager } from './state/manager.ts';
import { ActivityMonitor } from './monitor/activity.ts';
import { OutboundAdapter, matchesAddress } from './outbound/adapter.ts';
import { OutboundSender } from './outbound/sender.ts';
import { buildQqProactiveSendTool } from './tools/send.ts';
import { QuotaManager } from './state/quota.ts';
import { Scheduler } from './engine/scheduler.ts';
import { RoutineCoordinator } from './engine/routine.ts';
import { NudgeBuilder } from './prompt/nudge_builder.ts';
import { ProactivePanelDispatcher } from './webui/panel.ts';
import type { ProactiveScene, RoutinePhase, SendReceipt, TargetKind } from './types.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 默认调度周期：60 秒。测试可经构造参数缩短。 */
const DEFAULT_TICK_INTERVAL_MS = 60_000;
/** 启动自检延迟：一个 tick 多一点之后检查入站观测是否真的生效。 */
const STARTUP_SELF_CHECK_DELAY_MS = 75_000;
/** 单次 tick 内最多回放的入站事件数，避免长时间停机后一次性灌爆。 */
const INBOUND_DRAIN_LIMIT = 200;

/**
 * 健壮的事件时间戳解析器
 * 兼容 Unix 秒级、毫秒级时间戳、ISO 8601 日期字符串及 Date 对象
 */
export function parseTs(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') {
    return Date.now();
  }
  if (typeof raw === 'number') {
    if (raw > 0 && raw < 100_000_000_000) {
      return raw * 1000;
    }
    return raw > 0 ? raw : Date.now();
  }
  if (typeof raw === 'string') {
    const num = Number(raw.trim());
    if (!Number.isNaN(num) && num > 0) {
      if (num < 100_000_000_000) {
        return num * 1000;
      }
      return num;
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isNaN(t) ? Date.now() : t;
  }
  return Date.now();
}

interface Logger {
  debug?(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface ProactiveWorldOptions {
  /** 调度周期（毫秒）。生产固定 60s，测试可缩短以驱动真实路径。 */
  tickIntervalMs?: number;
  /** 启动自检延迟（毫秒）。 */
  selfCheckDelayMs?: number;
}

export class ProactiveWorld implements World {
  readonly id = PROACTIVE_WORLD_ID;
  private readonly ctx: WorldContext<ProactiveConfig>;
  /** 测试用的显式周期；生产由配置项 tickIntervalMs 决定。 */
  private readonly tickIntervalOverrideMs: number | null;
  private tickIntervalMs: number;
  private readonly selfCheckDelayMs: number;

  private host: WorldHost | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private selfCheckTimer: ReturnType<typeof setTimeout> | null = null;

  /** 入站游标：只增量读取开始之后的新事件，不重放历史。 */
  private lastCursor = 0;
  /** 启动时的历史水位，仅用于启动自检判断「库里有消息但我没观测到」。 */
  private startCursor = 0;
  private inboundObserved = 0;
  /** 本笔质押的主动事件是否已真正投递进主 session（回合归属）。 */
  private pledgedTurnArmed = false;
  /**
   * 投递之后是否真的开始过一轮新的模型调用。
   * 只靠 delivered 不够：事件可能搭进一轮已经在跑的批，那一轮结束时模型根本没看到它。
   */
  private pledgedTurnObserved = false;

  readonly stateManager: StateManager;
  readonly activityMonitor: ActivityMonitor;
  readonly outboundAdapter: OutboundAdapter;
  readonly sender: OutboundSender;
  readonly quotaManager: QuotaManager;
  readonly scheduler: Scheduler;
  readonly routineCoordinator: RoutineCoordinator;
  readonly panelDispatcher: ProactivePanelDispatcher;

  constructor(ctx: WorldContext<ProactiveConfig>, options: ProactiveWorldOptions = {}) {
    this.ctx = ctx;
    this.tickIntervalOverrideMs =
      typeof options.tickIntervalMs === 'number' ? Math.max(50, options.tickIntervalMs) : null;
    this.tickIntervalMs = this.tickIntervalOverrideMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.selfCheckDelayMs = Math.max(this.tickIntervalMs + 1_000, options.selfCheckDelayMs ?? STARTUP_SELF_CHECK_DELAY_MS);

    const storageDir = resolve(ctx.dataDir);
    this.stateManager = new StateManager(storageDir);
    this.activityMonitor = new ActivityMonitor(this.stateManager);
    this.outboundAdapter = new OutboundAdapter({
      toolName: resolveOutboundTool(ctx.cfg),
      toField: ctx.cfg.outboundToField || 'to',
      textField: ctx.cfg.outboundTextField || 'text',
      channelPrefix: ctx.cfg.channelPrefix || '',
    });
    this.sender = new OutboundSender({
      getConfig: () => this.ctx.cfg,
      log: {
        info: (m) => this.log().info(m),
        warn: (m) => this.log().warn(m),
        error: (m) => this.log().error(m),
      },
    });
    this.quotaManager = new QuotaManager(this.stateManager, this.activityMonitor);
    this.scheduler = new Scheduler(this.activityMonitor, this.quotaManager);
    this.routineCoordinator = new RoutineCoordinator();
    this.panelDispatcher = new ProactivePanelDispatcher({
      stateManager: this.stateManager,
      activityMonitor: this.activityMonitor,
      quotaManager: this.quotaManager,
      routineCoordinator: this.routineCoordinator,
      outboundAdapter: this.outboundAdapter,
      getConfig: () => this.ctx.cfg,
      updateConfig: (patch) => this.updateConfig(patch),
      triggerProactive: async (address, scene, force) => {
        const kind: TargetKind = address.startsWith('group:') ? 'group' : 'private';
        const guard = this.quotaManager.canTrigger(address, kind, this.ctx.cfg, {
          force,
          dndActive: this.routineCoordinator.isDndActive(this.ctx.cfg),
        });
        if (!guard.allowed) {
          return { success: false, reason: guard.reason };
        }
        const session = this.stateManager.getSession(address);
        const success = await this.dispatchProactiveTurn(
          address,
          kind,
          scene,
          session?.label,
          this.routineCoordinator.getPhase(this.ctx.cfg),
          force
        );
        return { success, reason: success ? undefined : '宿主事件派发失败' };
      },
    });
  }

  /** 配置热更新：内存生效 + 落盘（只写白名单两项等真实配置，merged whitelist 不进盘）。 */
  private updateConfig(patch: Partial<ProactiveConfig>): void {
    Object.assign(this.ctx.cfg, patch);
    try {
      const persisted: Partial<ProactiveConfig> = {};
      if (patch.whitelistPrivate !== undefined) persisted.whitelistPrivate = patch.whitelistPrivate;
      if (patch.whitelistGroup !== undefined) persisted.whitelistGroup = patch.whitelistGroup;
      if (patch.mode !== undefined) persisted.mode = patch.mode;
      if (patch.dailyQuota !== undefined) persisted.dailyQuota = patch.dailyQuota;
      if (patch.unrepliedThreshold !== undefined) persisted.unrepliedThreshold = patch.unrepliedThreshold;
      if (Object.keys(persisted).length && typeof this.ctx.persist === 'function') {
        this.ctx.persist(persisted);
      }
    } catch (err: any) {
      this.log().warn(`[主动搭话] 设置没能保存下来：${err?.message || err}。可以再改一次，或检查设置文件是否只读。`);
    }
  }

  private log(): Logger {
    const host = this.host;
    if (host?.log) return host.log;
    return {
      info: (m, f) => console.log(m, f ?? ''),
      warn: (m, f) => console.warn(m, f ?? ''),
      error: (m, f) => console.error(m, f ?? ''),
    };
  }

  /** 技术细节走 debug：cursor、分数、内部标记都不进 info（方案 9.7.3）。 */
  private debug(msg: string): void {
    this.log().debug?.(msg);
  }

  /** 作息时段的人话说法。 */
  private static phaseWords(phase: RoutinePhase): string {
    switch (phase) {
      case 'WAKE':
        return '清醒时段';
      case 'NOON_LAZY':
        return '午休时段';
      case 'NIGHT_QUIET':
        return '睡前放松时段';
      case 'SLEEP':
        return '睡觉时间';
      default:
        return String(phase);
    }
  }

  /** 地址的人话说法：private:123 → 123。 */
  private static addressWords(address: string): string {
    return String(address).replace(/^(?:private|group):/, '');
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const cfg = this.ctx.cfg;
    this.outboundAdapter.updateContract({
      toolName: resolveOutboundTool(cfg),
      toField: cfg.outboundToField || 'to',
      textField: cfg.outboundTextField || 'text',
      channelPrefix: cfg.channelPrefix || '',
    });

    // 记录起点：历史事件不重放，只观测装载之后的新消息
    try {
      this.startCursor = host.store.latestCursor();
    } catch {
      this.startCursor = 0;
    }
    this.lastCursor = this.startCursor;
    this.inboundObserved = 0;

    this.stateManager.setLastRoutinePhase(this.routineCoordinator.getPhase(cfg));

    const configuredSeconds = Number(cfg.tickIntervalMs);
    this.tickIntervalMs =
      this.tickIntervalOverrideMs ??
      (Number.isFinite(configuredSeconds) && configuredSeconds > 0
        ? Math.max(1_000, Math.round(configuredSeconds * 1_000))
        : DEFAULT_TICK_INTERVAL_MS);

    const problems = this.checkStartupConfig();

    this.tickTimer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    this.tickTimer.unref?.();

    this.selfCheckTimer = setTimeout(() => this.runStartupSelfCheck(), this.selfCheckDelayMs);
    this.selfCheckTimer.unref?.();

    const quotaText = `${this.stateManager.dailyCount}/${cfg.dailyQuota || '不限'}`;
    const phaseText = ProactiveWorld.phaseWords(this.stateManager.lastRoutinePhase);
    if (!cfg.enabled) {
      host.log.info(
        '[主动搭话] 已就绪，但目前是关闭状态，不会主动发消息。想启用请到设置里打开「允许它主动找你说话」。'
      );
    } else {
      host.log.info(`[主动搭话] 已启动：今天已说 ${quotaText} 次，当前是「${phaseText}」。`);
    }
    for (const problem of problems) {
      if (problem.level === 'error') host.log.error(`[主动搭话] ${problem.text}`);
      else host.log.warn(`[主动搭话] ${problem.text}`);
    }
    this.debug(
      `[主动搭话] 技术细节：检查间隔=${Math.round(this.tickIntervalMs / 1000)} 秒，读取起点=${this.startCursor}，` +
        `发信通道=${cfg.outboundMode ?? 'builtin'}，发信工具=${this.outboundAdapter.toolName}，` +
        `令牌=${maskToken(cfg.outboundHttpToken) || '未配置'}`
    );
  }

  /**
   * 启动防呆校验（方案 9.6.3）：发现问题就降级并明确告警，而不是让用户面对「什么都没发生」。
   */
  private checkStartupConfig(): Array<{ level: 'warn' | 'error'; text: string }> {
    const cfg = this.ctx.cfg;
    const out: Array<{ level: 'warn' | 'error'; text: string }> = [];
    const toNum = (v: unknown, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    let min = toNum(cfg.privateMinIntervalMin, PROACTIVE_DEFAULTS.privateMinIntervalMin);
    let max = toNum(cfg.privateMaxIntervalMin, PROACTIVE_DEFAULTS.privateMaxIntervalMin);
    if (min > max) {
      const low = Math.max(1, Math.round(max));
      const high = Math.max(1, Math.round(min));
      cfg.privateMinIntervalMin = low;
      cfg.privateMaxIntervalMin = high;
      min = low;
      max = high;
      out.push({ level: 'warn', text: '「最快多久说一次」比「最久隔多久」还大，已自动对调。' });
    }
    if (min < 1) {
      cfg.privateMinIntervalMin = 1;
      out.push({ level: 'warn', text: '「最快多久说一次」小于 1 分钟，已抬到 1 分钟，避免每分钟都来打扰。' });
    }
    if (toNum(cfg.dailyQuota, 20) <= 0) {
      out.push({ level: 'warn', text: '「每天最多主动找你几次」是 0，等于不限次数，可能刷屏。建议填 20。' });
    }
    if (toNum(cfg.unrepliedThreshold, 3) <= 0) {
      out.push({ level: 'warn', text: '「连着几次没回就先不说」是 0，等于对方一直不回也不会停。建议填 3。' });
    }
    if ((cfg.outboundMode ?? 'builtin') === 'external') {
      out.push({
        level: 'warn',
        text: '发信通道设为 external：本插件看不到发信结果，一律按未发出处理，也不会计入配额。',
      });
    }
    if ((cfg.outboundMode ?? 'builtin') === 'builtin') {
      const url = String(cfg.outboundHttpUrl ?? '').trim();
      if (url && !/^https?:\/\/\S+$/i.test(url)) {
        out.push({
          level: 'warn',
          text: `发信地址「${url}」看起来不是完整网址，主动搭话可能全部失败。请确认形如 http://127.0.0.1:3000。`,
        });
      }
    }
    if (cfg.enabled && parseWhitelist(cfg).length === 0) {
      out.push({ level: 'warn', text: '已开启主动搭话，但「能主动找的 QQ 号」是空的，所以不会发出任何消息。' });
    }
    if (cfg.enabled && toNum(cfg.dailyQuota, 20) <= 0 && toNum(cfg.privateMinIntervalMin, 60) <= 1) {
      cfg.dailyQuota = 20;
      out.push({
        level: 'error',
        text: '检测到「不限次数 + 最少间隔 1 分钟」的危险组合，已自动把每日上限降级为 20 次。',
      });
    }
    return out;
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.selfCheckTimer) {
      clearTimeout(this.selfCheckTimer);
      this.selfCheckTimer = null;
    }
    const pledge = this.quotaManager.activePledge;
    if (pledge) {
      this.quotaManager.rollbackPledge('world_stopping', pledge.id);
    }
    this.pledgedTurnArmed = false;
    this.pledgedTurnObserved = false;
    this.host?.log.info('[主动搭话] 已停止。');
    this.host = null;
  }

  /**
   * 自驱动的调度周期：先补入站观测，再跑作息跃迁与候选挑选。
   * 该方法不在 Core 契约内，由 start() 的定时器调用。
   */
  async tick(): Promise<void> {
    if (!this.host) return;

    try {
      this.drainInbound();

      const cfg = this.ctx.cfg;
      if (!cfg.enabled) return;

      const now = new Date();
      let dndActive = false;

      if (cfg.routineEnabled) {
        const currentPhase = this.routineCoordinator.getPhase(cfg, now);
        const lastPhase = this.stateManager.lastRoutinePhase;
        const transition = this.routineCoordinator.checkTransition(lastPhase, currentPhase, cfg.announceRoutine);

        if (transition) {
          this.stateManager.setLastRoutinePhase(currentPhase);
          if (transition.scene) {
            this.log().info(
              `[主动搭话] 进入「${ProactiveWorld.phaseWords(currentPhase)}」，接下来会按这个时段调整说话频率。`
            );
            this.debug(`[主动搭话] 时段切换：${lastPhase} -> ${currentPhase}（场景 ${transition.scene}）`);
            await this.triggerRoutineTransitionBroadcast(transition.scene, currentPhase);
          }
        }

        dndActive = this.routineCoordinator.isDndActive(cfg, now);
        if (dndActive) return;
      }

      const best = this.scheduler.pickBestCandidate(cfg, { dndActive });
      if (!best) return;

      this.log().info(
        `[主动搭话] 决定找 ${ProactiveWorld.addressWords(best.session.address)} 说话（已安静 ${best.silenceMinutes} 分钟）。`
      );
      this.debug(`[主动搭话] 候选打分：得分=${best.score.toFixed(1)}，原因=${best.reason}`);

      await this.dispatchProactiveTurn(best.session.address, best.session.kind, 'idle_chat', best.session.label);
    } catch (err: any) {
      this.log().error(
        `[主动搭话] 挑选说话对象时出错了：${err?.message || err}。` +
          '如果反复出现，请检查「发信地址」与「访问令牌」是否填对，或先关掉本插件。'
      );
    }
  }

  /**
   * 入站观测：按游标增量读取宿主事件库，只认真正的 qq.message。
   * poke / react / recall / member / reminder 等弱信号一律不计入活跃度，
   * 否则群里任何人戳一下就会清零未回复计数，防打扰形同虚设。
   */
  private drainInbound(): void {
    const host = this.host;
    if (!host) return;

    let latest = 0;
    try {
      latest = host.store.latestCursor();
    } catch (err: any) {
      this.log().warn(`[主动搭话] 读不到聊天记录的位置：${err?.message || err}。这一轮先跳过，下一轮会重试。`);
      return;
    }
    if (latest <= this.lastCursor) return;

    const from = this.lastCursor + 1;
    const to = Math.min(latest, from + INBOUND_DRAIN_LIMIT - 1);
    let events: EventEnvelope[] = [];
    try {
      events = host.store.range({ fromCursor: from, toCursor: to });
    } catch (err: any) {
      this.log().warn(`[主动搭话] 这次没读到新消息：${err?.message || err}。下一轮会重试。`);
      return;
    }
    this.lastCursor = to;

    for (const event of events) {
      // 桥接模式下 QQ 消息由桥插件投递给桌宠，事件类型是 astrbot.message；
      // 两种模式各认各的，避免同一条消息被算两次。
      if (event.type !== this.inboundType()) continue;

      const meta = (event.meta ?? {}) as Record<string, unknown>;
      if (event.origin === 'internal' || meta.self === true || meta.role === 'assistant') continue;
      // 撤回/戳一戳/入群这类通知行不算对方在跟你说话
      if (meta.notice === true) continue;

      const address = this.resolveInboundAddress(meta, event.senderKey);
      if (!address) continue;

      const kind: TargetKind = address.startsWith('group:') ? 'group' : 'private';
      const label = this.resolveInboundLabel(meta, event.text);

      this.activityMonitor.observeMessage({
        address,
        kind,
        isFromUser: true,
        label,
        text: event.text,
        ts: parseTs(event.ts),
      });
      this.inboundObserved += 1;

      // 并发冲突快速熔断：质押期间目标会话来了新消息，立即按 id 作废这笔质押
      const pledge = this.quotaManager.activePledge;
      if (pledge && matchesAddress(address, pledge.address)) {
        this.quotaManager.rollbackPledge('conflict_aborted', pledge.id);
      }
    }

    if (to < latest) {
      this.log().info(`[主动搭话] 刚补读了 ${to - from + 1} 条错过的消息。`);
    }
  }

  /**
   * 启动自检：库里有 QQ 消息事件却一条都没观测到，说明入站链路静默失效，立刻告警。
   */
  private runStartupSelfCheck(): void {
    const host = this.host;
    if (!host) return;
    try {
      const latest = host.store.latestCursor();
      if (latest <= this.startCursor) return;
      const events = host.store.range({ fromCursor: this.startCursor + 1, toCursor: latest });
      const inbound = events.filter((e) => e.type === this.inboundType()).length;
      if (inbound > 0 && this.inboundObserved === 0) {
        this.log().warn(
          `[主动搭话] 收到了 ${inbound} 条新消息，却一条都没记进去，说明「看消息」这步没生效。` +
            '如果一直这样，请把本插件关掉再开一次；仍未好转请反馈这个问题。'
        );
      }
    } catch (err: any) {
      this.log().warn(`[主动搭话] 启动自检没跑完：${err?.message || err}。不影响使用。`);
    }
  }

  /**
   * 触发作息边界播报（早安/午休/晚安，面向白名单亲密联系人）
   */
  private async triggerRoutineTransitionBroadcast(
    scene: 'routine_wake' | 'routine_noon' | 'routine_sleep',
    phase: RoutinePhase
  ): Promise<void> {
    const whitelist = parseWhitelist(this.ctx.cfg);
    if (!whitelist.length) return;

    for (const address of whitelist) {
      const kind: TargetKind = address.startsWith('group:') ? 'group' : 'private';
      const guard = this.quotaManager.canTrigger(address, kind, this.ctx.cfg, { dndActive: false });
      if (!guard.allowed) continue;

      const session = this.stateManager.getSession(address);
      await this.dispatchProactiveTurn(address, kind, scene, session?.label, phase);
      break; // 每次边界只播报优先级最高的一个亲密联系人，避免刷屏
    }
  }

  /**
   * 构造标准 Nudge 并向 Coopanion 宿主派发主动事件
   * 事件带 source 与 pledgeId，便于 onEventsSettled 精确判断「我这条到底投递成功没有」。
   */
  /**
   * 派发之后安排下一次允许派发的时间。
   * 间隔由配置的最小/最大值决定：两者相等是固定间隔，否则在区间内随机。
   * 无论这一轮是真发出去了还是模型选择了安静，都会写回，
   * 避免"静默 → 回滚 → 下一个 tick 又派发"的空转。
   */
  private scheduleNextDispatch(address: string, kind: TargetKind): void {
    const cfg = this.ctx.cfg;
    const min = Math.max(1, kind === 'private' ? cfg.privateMinIntervalMin : cfg.groupMinIntervalMin);
    const max = Math.max(min, kind === 'private' ? cfg.privateMaxIntervalMin : cfg.groupMaxIntervalMin);
    const waitMs = min === max ? min * 60_000 : this.scheduler.getRandomIntervalMs(min, max);
    this.stateManager.updateSession(address, (s) => {
      s.nextScheduledTime = Date.now() + waitMs;
    });
  }

  async dispatchProactiveTurn(
    address: string,
    kind: TargetKind,
    scene: ProactiveScene,
    label?: string,
    routinePhase?: RoutinePhase,
    force: boolean = false
  ): Promise<boolean> {
    if (!this.host) return false;

    const guard = this.quotaManager.canTrigger(address, kind, this.ctx.cfg, {
      force,
      dndActive: this.routineCoordinator.isDndActive(this.ctx.cfg),
    });
    if (!guard.allowed) return false;

    this.pledgedTurnArmed = false;
    this.pledgedTurnObserved = false;

    const pledged = this.quotaManager.pledge(
      address,
      kind,
      scene,
      this.outboundAdapter.toolName,
      label
    );

    const session = this.stateManager.getOrCreateSession(address, kind, label);
    const phase = routinePhase || this.routineCoordinator.getPhase(this.ctx.cfg);

    const nudgeText = NudgeBuilder.build({
      session,
      scene,
      routinePhase: phase,
      outboundTool: this.outboundAdapter.toolName,
      withNickname: this.ctx.cfg.withNickname,
      allowSilence: this.ctx.cfg.allowSilence,
      silenceMinutes: Math.round(this.activityMonitor.getSilenceDurationMs(address) / 60_000),
      mode: this.sender.mode,
    });

    const event = {
      type: 'im.proactive.turn',
      source: this.id,
      origin: 'internal' as const,
      ts: new Date().toISOString(),
      text: nudgeText,
      senderKey: address,
      meta: {
        channel: 'qq',
        targetAddress: address,
        targetKind: kind,
        targetName: label,
        scene,
        outboundTool: this.outboundAdapter.toolName,
        pledgedAt: pledged.pledgedAt,
        pledgeId: pledged.id,
      },
    };

    try {
      await this.host.pushEvent(event, { trigger: 'flush' });
      this.scheduleNextDispatch(address, kind);
      return true;
    } catch (err: any) {
      this.log().warn(`[主动搭话] 这次没唤醒成功：${err?.message || err}。额度已退回，下次再试。`);
      this.quotaManager.rollbackPledge('event_dispatch_failed', pledged.id);
      return false;
    }
  }

  /**
   * 本 World 事件离开队列时回调：delivered 才把质押标记为「已进入本批」，
   * discarded 直接回滚。这是回合归属的可靠信号。
   */
  onEventsSettled(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded'): void {
    const pledge = this.quotaManager.activePledge;
    if (!pledge) return;

    for (const event of events) {
      const meta = (event.meta ?? {}) as Record<string, unknown>;
      if (meta.pledgeId !== pledge.id) continue;

      if (outcome === 'delivered') {
        this.pledgedTurnArmed = true;
        this.log().info(`[主动搭话] 已唤醒模型，正在为 ${ProactiveWorld.addressWords(pledge.address)} 组织语言。`);
        this.debug(`[主动搭话] 事件已进入主 session（token=${pledge.id}，目标=${pledge.address}）`);
      } else {
        this.log().warn('[主动搭话] 这次搭话没能送进对话，额度已退回，下次再试。');
        this.debug(`[主动搭话] 事件被丢弃（token=${pledge.id}）`);
        this.quotaManager.rollbackPledge('event_discarded', pledge.id);
        this.pledgedTurnArmed = false;
        this.pledgedTurnObserved = false;
      }
      return;
    }
  }

  /**
   * 运行阶段钩子：只用来判断「投递之后是否真的起了一轮新的模型调用」。
   * 发信是否成功一律以发信工具的真实回执为准，这里不参与记账。
   */
  onRunPhase(phase: RunPhase): void {
    if (!phase || !this.pledgedTurnArmed) return;
    if (phase.state === 'model') {
      this.pledgedTurnObserved = true;
      return;
    }
    // 桥接模式：发信由模型调 astrbot_send_message 完成，本扩展拿不到平台回执，
    // 只能在观测到该工具被执行时乐观记账；模型没调就按「这轮没发出去」回滚。
    if (
      this.bridgeMode() &&
      phase.state === 'tools' &&
      Array.isArray(phase.running) &&
      phase.running.includes(this.outboundAdapter.toolName)
    ) {
      this.pledgedTurnObserved = true;
      this.settleBridgeOutbound();
    }
  }

  /** 桥接模式的乐观核销：按「模型确实调了发信工具」记账。 */
  private settleBridgeOutbound(): void {
    const pledge = this.quotaManager.activePledge;
    if (!pledge) return;

    const ok = this.quotaManager.verifyOutboundSent(pledge.address, '', pledge.id);
    if (!ok) return;

    this.pledgedTurnArmed = false;
    this.pledgedTurnObserved = false;
    this.activityMonitor.observeMessage({
      address: pledge.address,
      kind: pledge.kind,
      isFromUser: false,
      text: '',
      ts: Date.now(),
    });
    this.log().info(
      `[主动搭话] 已经跟 ${ProactiveWorld.addressWords(pledge.address)} 说过了，今天第 ${this.stateManager.dailyCount} 次。`
    );
    this.debug(`[主动搭话] 桥接模式乐观核销（目标=${pledge.address}，工具=${this.outboundAdapter.toolName}）`);
  }

  /** 桥接模式：QQ 收发已交给 AstrBot 侧的桥接管。 */
  private bridgeMode(): boolean {
    return this.ctx.cfg.outboundMode === 'bridge';
  }

  /** 本模式认哪一种入站事件类型。 */
  private inboundType(): string {
    return this.bridgeMode() ? 'astrbot.message' : 'qq.message';
  }

  /**
   * 会话地址：桥接模式下 meta.conv 是 {kind,id,name} 对象，
   * 直接 String() 会得到 "[object Object]"；senderKey 只是发送者 id（群里会错发成私聊）。
   */
  private resolveInboundAddress(meta: Record<string, unknown>, senderKey?: string): string {
    const conv = meta.conv;
    if (conv && typeof conv === 'object') {
      const c = conv as { kind?: string; id?: string | number };
      const id = String(c.id ?? '').trim();
      if (id) {
        const kind = String(c.kind ?? '').trim();
        return kind ? `${kind}:${id}` : id;
      }
    }
    const raw = typeof conv === 'string' ? conv.trim() : '';
    return raw || String(senderKey ?? '').trim();
  }

  /**
   * 昵称：桥接模式没有 card/sender 字段，从事件行行首解析
   * 「【QQ私聊 19:19】#消息号 昵称(QQ:123, 主人)：正文」。
   */
  private resolveInboundLabel(meta: Record<string, unknown>, text?: string): string | undefined {
    const conv = meta.conv;
    if (conv && typeof conv === 'object') {
      const name = String((conv as { name?: string }).name ?? '').trim();
      if (name) return name;
    }
    const line = String(text ?? '');
    const matched = line.match(/^【[^】]*】\s*#\S+\s*([^：:（(]{1,20}?)(?:[(（][^）)]*[）)])?[:：]/);
    if (matched) {
      const name = matched[1].trim();
      if (name) return name;
    }
    if (typeof meta.card === 'string' && meta.card.trim()) return meta.card.trim();
    if (typeof meta.sender === 'string' && meta.sender.trim()) return meta.sender.trim();
    return undefined;
  }

  /**
   * 回合结束：只有「主动事件已投递」且「投递之后起过一轮模型调用」的那一轮结束才结算。
   * 若事件只是搭进了别人已在跑的批，这一轮结束时模型根本没看到它，此时不得回滚，
   * 否则主动搭话会在宠物正忙的时刻被系统自己吃掉。
   */
  onTurnEnded(): void {
    const pledge = this.quotaManager.activePledge;

    if (!this.pledgedTurnArmed) return;

    if (!pledge) {
      this.pledgedTurnArmed = false;
      this.pledgedTurnObserved = false;
      return;
    }

    if (!this.pledgedTurnObserved) {
      this.debug(`[主动搭话] 本轮不是这次搭话的回合，先等着（token=${pledge.id}）`);
      return;
    }

    this.pledgedTurnArmed = false;
    this.pledgedTurnObserved = false;
    this.quotaManager.rollbackPledge('turn_ended_without_verified_outbound', pledge.id);
    // 这一轮模型选择了安静：同样要写回派发冷却，否则下一个 tick 又会重派一次
    this.scheduleNextDispatch(pledge.address, pledge.kind);
  }

  /** 自建发信工具成功后的记账回调；无在途质押时只发信不记账。 */
  private recordOutboundSuccess(address: string, text: string, receipt: SendReceipt): boolean {
    const pledge = this.quotaManager.activePledge;
    if (!pledge) return false;

    const ok = this.quotaManager.verifyOutboundSent(address, text, pledge.id);
    if (ok) {
      this.pledgedTurnArmed = false;
      this.pledgedTurnObserved = false;
      this.activityMonitor.observeMessage({
        address: pledge.address,
        kind: pledge.kind,
        isFromUser: false,
        text,
        ts: Date.now(),
      });
      this.log().info(`[主动搭话] 已经跟 ${ProactiveWorld.addressWords(pledge.address)} 说过了，今天第 ${this.stateManager.dailyCount} 次。`);
      this.debug(`[主动搭话] 发信成功（目标=${pledge.address}，message_id=${receipt.messageId ?? 'n/a'}）`);
    }
    return ok;
  }

  private promptText(): string {
    const custom = (this.ctx.cfg.promptText ?? '').trim();
    return custom || (this.ctx.cfg.allowSilence === false
      ? PROACTIVE_DEFAULT_PROMPT_FORCED
      : PROACTIVE_DEFAULT_PROMPT);
  }

  envPromptVars(): Record<string, string> | null {
    if (this.ctx.cfg.promptEnabled === false) return null;
    const phase = this.routineCoordinator.getPhase(this.ctx.cfg);
    const phaseLabels: Record<RoutinePhase, string> = {
      WAKE: '清醒活跃期',
      NOON_LAZY: '午休惬意期',
      NIGHT_QUIET: '睡前放松期',
      SLEEP: '深睡休眠期（禁发）',
    };
    const phaseLabel = phaseLabels[phase] || phase;
    const whitelist = parseWhitelist(this.ctx.cfg).join('、') || '（未配置）';
    const dailyQuota = this.ctx.cfg.dailyQuota || 20;

    return {
      proactiveStatus: `${this.ctx.cfg.enabled ? '已启用' : '已停用'}，作息：${phaseLabel}`,
      proactiveWhitelist: whitelist,
      proactiveQuota: `${this.stateManager.dailyCount} / ${dailyQuota} 次`,
      outboundTool: this.outboundAdapter.toolName,
      proactiveGuidance: this.promptText(),
      stickerHint: this.bridgeMode()
        ? '正文发出后调 qq_sticker_send 补一张表情包（配不配由它掷骰，没过就纯文字收尾）；不要在发信工具里带图。'
        : '配图由发送侧按概率自动附带，正文不要提及图片；想自己挑可调表情工具拿真实路径。',
    };
  }

  webUi(): WorldWebUiDecl {
    const phase = this.routineCoordinator.getPhase(this.ctx.cfg);
    const phaseTone = phase === 'SLEEP' ? 'off' : phase === 'NOON_LAZY' ? 'plain' : 'on';
    const dailyQuota = this.ctx.cfg.dailyQuota || 20;
    const whitelist = parseWhitelist(this.ctx.cfg);

    return {
      badges: [
        // 模式徽章放最前面，并提示它需要重启 World 才生效（配置项本身也这么写）。
        {
          label: '发信通道',
          value:
            this.sender.mode === 'bridge'
              ? 'AstrBot 桥'
              : this.sender.mode === 'external'
                ? '外部 World'
                : '自建 OneBot',
          tone: this.sender.mode === 'bridge' ? 'on' : 'plain',
        },
        {
          label: '今日配额',
          value: `${this.stateManager.dailyCount}/${dailyQuota}`,
          tone: this.ctx.cfg.enabled ? 'on' : 'off',
        },
        { label: '作息', value: phase, tone: phaseTone },
        { label: '白名单', value: `${whitelist.length}个`, tone: 'plain' },
      ],
      panels: [{ id: 'dashboard', title: '搭话控制台', getMethods: ['status'] }],
      invoke: (panel: string, method: string, args: unknown[]) => this.panelDispatcher.invoke(panel, method, args),
      config: proactiveConfigGroups(),
      promptDocs: [
        {
          key: 'worlds.qq-initiative.envPrompt',
          title: 'QQ主动搭话 · 环境提示词',
          description: '注入到大模型系统前缀：当前搭话状态、作息时段、今日配额用量与关心纪律。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt' as const,
          vars: [
            { name: 'proactiveStatus', description: '当前主动搭话状态' },
            { name: 'proactiveWhitelist', description: '白名单会话列表' },
            { name: 'proactiveQuota', description: '今日搭话频次与配额' },
            { name: 'outboundTool', description: '发信工具名称' },
            { name: 'stickerHint', description: '配图说明（按发信通道不同）' },
            { name: 'proactiveGuidance', description: '主动搭话风格与纪律引导' },
          ],
        },
      ],
    };
  }

  tools(): ToolDef[] {
    return this.buildTools();
  }

  buildTools(): ToolDef[] {
    const json = (value: unknown) => JSON.stringify(value, null, 2);
    const tools: ToolDef[] = [];

    // 自建发信工具只在 builtin 模式注册：external 模式下本扩展观测不到参数与结果，
    // 注册一个「发得出但记不准」的工具只会制造虚账。
    if (this.sender.mode === 'builtin') {
      tools.push(
        buildQqProactiveSendTool({
          getConfig: () => this.ctx.cfg,
          sender: this.sender,
          onSent: (address, text, receipt) => this.recordOutboundSuccess(address, text, receipt),
          onSendFailed: (address, reason) => {
            const pledge = this.quotaManager.activePledge;
            if (pledge) {
              this.quotaManager.rollbackPledge(`send_failed:${reason}`, pledge.id);
            }
            this.log().warn(
              `[主动搭话] 这次没发出去给 ${ProactiveWorld.addressWords(address)}（${reason}）。额度已退回。` +
                '若是「连不上」或「令牌不对」，请检查发信地址与访问令牌。'
            );
          },
        })
      );
    }

    const statusExecute = async (args: Record<string, unknown>) => {
      const address = typeof args.address === 'string' ? args.address : undefined;
      if (address) {
        const session = this.activityMonitor.getSessionActivity(address);
        const silenceMs = this.activityMonitor.getSilenceDurationMs(address);
        return {
          status: 'ok',
          session: session || null,
          silenceMinutes: Math.round(silenceMs / 60000),
          activePledge: this.quotaManager.activePledge,
        };
      }

      const currentPhase = this.routineCoordinator.getPhase(this.ctx.cfg);
      const isDnd = this.routineCoordinator.isDndActive(this.ctx.cfg);
      const whitelist = parseWhitelist(this.ctx.cfg);

      return {
        status: 'ok',
        dailyCount: this.stateManager.dailyCount,
        dailyQuota: this.ctx.cfg.dailyQuota,
        whitelist,
        whitelistCount: whitelist.length,
        totalSessionsTracked: this.activityMonitor.getAllSessions().length,
        activePledge: this.quotaManager.activePledge,
        outboundMode: this.ctx.cfg.outboundMode ?? 'builtin',
        outboundTool: this.outboundAdapter.toolName,
        outboundTokenMasked: maskToken(this.ctx.cfg.outboundHttpToken) || '（未配置）',
        routine: {
          currentPhase,
          lastPhase: this.stateManager.lastRoutinePhase,
          isDndActive: isDnd,
        },
        recentAudit: this.stateManager.data.auditLog.slice(-5),
      };
    };

    const triggerExecute = async (args: Record<string, unknown>) => {
      let address = String(args.address ?? '').trim();
      if (/^\d+$/.test(address)) address = `private:${address}`;
      const kind: TargetKind = address.startsWith('group:') ? 'group' : 'private';
      const scene = (args.scene as ProactiveScene) || 'idle_chat';
      const force = Boolean(args.force);

      const guard = this.quotaManager.canTrigger(address, kind, this.ctx.cfg, {
        force,
        dndActive: this.routineCoordinator.isDndActive(this.ctx.cfg),
      });
      if (!guard.allowed) {
        return { status: 'rejected', reason: guard.reason };
      }

      const ok = await this.dispatchProactiveTurn(address, kind, scene, this.stateManager.getSession(address)?.label, undefined, force);
      if (!ok) {
        return { status: 'error', reason: '宿主事件派发失败' };
      }

      return {
        status: 'pledged',
        pledged: this.quotaManager.activePledge,
        message: '主动回合事件已投递，等待发信核销或静默回滚',
      };
    };

    const resetExecute = async (args: Record<string, unknown>) => {
      const target = (args.target as string) || 'all';
      const address = typeof args.address === 'string' ? args.address : undefined;

      if (target === 'daily_quota') {
        this.stateManager.resetDailyCount();
        return {
          status: 'ok',
          message: '今日主动发信配额计数已成功重置为 0',
          dailyCount: this.stateManager.dailyCount,
        };
      }

      if (target === 'session') {
        if (!address) {
          return { status: 'error', message: '当 target 为 session 时必须传入 address 参数' };
        }
        const ok = this.stateManager.resetSession(address);
        if (!ok) {
          return { status: 'error', message: `未找到地址为 ${address} 的会话记录` };
        }
        return {
          status: 'ok',
          message: `会话 ${address} 的未回复计数与主动冷却已清零`,
          session: this.stateManager.getSession(address),
        };
      }

      this.stateManager.resetAll();
      return {
        status: 'ok',
        message: '今日已发配额与所有会话的未回复计数已全部重置',
        dailyCount: this.stateManager.dailyCount,
      };
    };

    return [
      ...tools,
      {
        name: 'qq_initiative_status',
        description: '查询当前 QQ主动搭话引擎的运行状态、作息时段、今日已发配额、白名单与各会话活跃度统计',
        parameters: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: '可选的指定会话地址（private:<QQ号>），不传则返回概览',
            },
          },
        },
        tags: ['read'],
        handler: async (args) => json(await statusExecute(args)),
      },
      {
        name: 'qq_initiative_trigger',
        description: '手动触发对指定白名单会话的主动搭话测试（QQ 调试与强制唤醒用，仍受白名单与作息约束）',
        parameters: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: '目标会话地址（private:<QQ号>）',
            },
            scene: {
              type: 'string',
              description: '主动场景类型',
              enum: ['idle_chat', 'routine_wake', 'routine_noon', 'routine_sleep'],
            },
            force: {
              type: 'boolean',
              description: '是否放宽今日配额与同会话最小区间（不能越过白名单、免打扰时段与未回复阈值）',
            },
          },
          required: ['address'],
        },
        tags: ['write'],
        handler: async (args) => json(await triggerExecute(args)),
      },
      {
        name: 'qq_initiative_reset',
        description: '手动重置 QQ主动搭话配额或会话未回复冷却计数（管理与自测用）',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: '重置目标类型：daily_quota（重置今日已发配额）、session（重置指定会话的未回复计数与冷却）、all（全部重置）',
              enum: ['daily_quota', 'session', 'all'],
            },
            address: {
              type: 'string',
              description: '当 target 为 session 时必须指定的会话地址',
            },
          },
        },
        tags: ['write'],
        handler: async (args) => json(await resetExecute(args)),
      },
    ];
  }
}

export const PROACTIVE_WORLD_DEF: WorldDefinition<ProactiveConfig> = {
  id: PROACTIVE_WORLD_ID,
  label: PROACTIVE_WORLD_LABEL,
  defaults: () => ({ ...PROACTIVE_DEFAULTS }),
  create: (ctx: WorldContext<ProactiveConfig>) => new ProactiveWorld(ctx),
  describe: {
    tools: [
      {
        name: 'qq_initiative_send',
        description: '主动搭话专用发信渠道：向指定 QQ 私聊或群发送一条消息',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: '投递地址（private:<QQ号> 或 group:<群号>）' },
            text: { type: 'string', description: '消息正文' },
          },
          required: ['to', 'text'],
        },
        tags: ['speak'],
        summary: { zh: '主动搭话专用发信渠道。', en: 'Send a proactive QQ message.' },
      },
      {
        name: 'qq_initiative_status',
        description: '查询当前 QQ主动搭话引擎的运行状态、作息时段、今日已发配额及会话活跃度统计',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: '可选的指定会话地址（private:<QQ号>）' },
          },
        },
        tags: ['read'],
        summary: { zh: '查询 QQ主动搭话运行状态与配额。', en: 'Check QQ proactive chat status and quota.' },
      },
      {
        name: 'qq_initiative_trigger',
        description: '手动触发对指定白名单会话的主动搭话测试（调试与强制唤醒用）',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: '目标会话地址（private:<QQ号>）' },
            scene: {
              type: 'string',
              description: '主动场景类型：idle_chat、routine_wake、routine_noon、routine_sleep',
              enum: ['idle_chat', 'routine_wake', 'routine_noon', 'routine_sleep'],
            },
            force: { type: 'boolean', description: '是否放宽今日配额与同会话最小区间（默认 false）' },
          },
          required: ['address'],
        },
        tags: ['write'],
        summary: { zh: '手动触发对指定会话的主动搭话测试。', en: 'Manually trigger proactive test for a session.' },
      },
      {
        name: 'qq_initiative_reset',
        description: '手动重置 QQ主动搭话配额或会话未回复冷却计数（管理与自测用）',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: '重置目标类型：daily_quota、session、all',
              enum: ['daily_quota', 'session', 'all'],
            },
            address: { type: 'string', description: '当 target 为 session 时必须指定的会话地址' },
          },
        },
        tags: ['write'],
        summary: { zh: '重置主动搭话配额或会话冷却计数。', en: 'Reset proactive quota or session cooldown.' },
      },
    ],
    events: [
      {
        type: 'im.proactive.turn',
        description: {
          zh: '主动搭话触发事件：唤醒桌宠主模型按白名单与防打扰纪律自主决定是否发信。',
          en: 'Proactive chat nudge: wakes the main model to decide whether to speak.',
        },
      },
    ],
  },
};

export const id = PROACTIVE_WORLD_DEF.id;
export const label = PROACTIVE_WORLD_DEF.label;
export const defaults = PROACTIVE_WORLD_DEF.defaults;
export const create = PROACTIVE_WORLD_DEF.create;
export const describe = PROACTIVE_WORLD_DEF.describe;
export const defaultConfig = PROACTIVE_DEFAULTS;
export const worldDefinition = PROACTIVE_WORLD_DEF;
export default PROACTIVE_WORLD_DEF;
