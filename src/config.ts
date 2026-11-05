/**
 * 配置项定义与标准 Schema
 *
 * 按「改错的后果」分三层（方案 9.6.1）：
 * - 基础：改错只是「说得太勤/太少」→ 面板第一张卡；
 * - 高级：改错影响表现与风格 → 面板第二张卡；
 * - 运营/危险：改错会「功能消失 / 发错地方 / 泄露凭据」→ 不进面板，只能改配置文件（README 有表）。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export const PROACTIVE_WORLD_ID = 'qq-initiative';
export const PROACTIVE_WORLD_LABEL = 'QQ主动搭话';

/** builtin 模式下本扩展自己注册的发信工具名。 */
export const BUILTIN_SEND_TOOL_NAME = 'qq_initiative_send';

/**
 * bridge 模式的发信工具名：QQ 收发改由 AstrBot 侧的桥插件接管后，
 * 本扩展不再自己发信，而是让模型调桌宠侧桥 World 提供的 astrbot_send_message。
 */
export const BRIDGE_SEND_TOOL_NAME = 'astrbot_send_message';

export interface ProactiveConfig {
  enabled: boolean;
  mode: 'all' | 'private' | 'group';
  /** 派生的合并白名单缓存，不落盘；真实来源是下面两个字段。 */
  whitelist: string[] | string;
  whitelistPrivate?: string[] | string;
  whitelistGroup?: string[] | string;

  // 发信通道（运营层）
  outboundMode: 'builtin' | 'external' | 'bridge';
  outboundHttpUrl: string;
  outboundHttpToken: string;
  outboundHttpTimeoutMs: number;

  // 抽象发信契约（运营层）
  outboundTool: string;
  outboundToField: string;
  outboundTextField: string;
  channelPrefix: string;

  /** 内部检查频率（秒）。只影响观测延迟，不影响「多久说一次话」。 */
  tickIntervalMs: number;

  // 频次与配额
  dailyQuota: number;
  unrepliedThreshold: number;

  // 调度间隔（分钟）
  privateMinIntervalMin: number;
  privateMaxIntervalMin: number;
  groupMinIntervalMin: number;
  groupMaxIntervalMin: number;

  // 作息与免打扰
  routineEnabled: boolean;
  sleepStart: string;
  sleepEnd: string;
  lazyStart: string;
  lazyEnd: string;
  announceRoutine: boolean;

  // 拟人化参数
  withNickname: boolean;
  allowSilence: boolean;

  // 提示词注入
  promptEnabled?: boolean;
  promptText?: string;
}

/** 注入 system 前缀的长期纪律：只讲总原则，操作细节留给 nudge（方案 9.8.3）。 */
export const PROACTIVE_DEFAULT_PROMPT =
  '主动搭话的门槛是这句他接得住：有由头就说具体的，没由头不必硬找话题；他没回不追问，夜深了轻声。';

/** 关闭「自行判断」时的引导语：不再暗示可以沉默，否则模型会自行选择不开口。 */
export const PROACTIVE_DEFAULT_PROMPT_FORCED =
  '这一轮必须开口：挑一件具体的、他接得住的由头，别催别问、别没话找话；夜深了轻声。';

/**
 * 安全默认值：装好之后什么都不做。
 * 白名单为空 → 硬排除保证不会向任何地址发送；发信地址留空，由 sender 内部兜底本机默认端口。
 */
export const PROACTIVE_DEFAULTS: ProactiveConfig = {
  enabled: false,
  mode: 'private',
  whitelist: [],
  whitelistPrivate: '',
  whitelistGroup: '',

  outboundMode: 'builtin',
  outboundHttpUrl: '',
  outboundHttpToken: '',
  outboundHttpTimeoutMs: 8000,

  outboundTool: BUILTIN_SEND_TOOL_NAME,
  outboundToField: 'to',
  outboundTextField: 'text',
  channelPrefix: '',

  tickIntervalMs: 60,

  dailyQuota: 20,
  unrepliedThreshold: 3,

  privateMinIntervalMin: 60,
  privateMaxIntervalMin: 360,
  groupMinIntervalMin: 180,
  groupMaxIntervalMin: 720,

  routineEnabled: true,
  sleepStart: '23:30',
  sleepEnd: '08:00',
  lazyStart: '12:30',
  lazyEnd: '14:00',
  announceRoutine: true,

  withNickname: true,
  allowSilence: true,

  promptEnabled: true,
  promptText: '',
};

/**
 * 解析实际生效的发信工具名：
 * builtin 模式默认使用本扩展自建的 qq_initiative_send；
 * external 模式本扩展不注册发信工具，默认指向宿主里常见的 QQ 发信工具名（标识符，不是对外文案）；
 * bridge 模式 QQ 收发已交给 AstrBot 侧的桥接管，默认指向桌宠侧桥 World 的 astrbot_send_message。
 */
export function resolveOutboundTool(cfg: ProactiveConfig): string {
  const configured = typeof cfg.outboundTool === 'string' ? cfg.outboundTool.trim() : '';
  if (cfg.outboundMode === 'external') {
    return !configured || configured === PROACTIVE_DEFAULTS.outboundTool ? 'qq_send' : configured;
  }
  if (cfg.outboundMode === 'bridge') {
    return !configured || configured === PROACTIVE_DEFAULTS.outboundTool
      ? BRIDGE_SEND_TOOL_NAME
      : configured;
  }
  return configured || PROACTIVE_DEFAULTS.outboundTool;
}

export function splitWhitelist(whitelist: string[]): {
  privateIds: string[];
  groupIds: string[];
  privateText: string;
  groupText: string;
} {
  const privateIds: string[] = [];
  const groupIds: string[] = [];

  for (const item of whitelist) {
    const raw = String(item).trim();
    if (raw.startsWith('group:')) {
      const id = raw.slice(6).replace(/\D/g, '');
      if (id && !groupIds.includes(id)) groupIds.push(id);
    } else if (raw.startsWith('private:')) {
      const id = raw.slice(8).replace(/\D/g, '');
      if (id && !privateIds.includes(id)) privateIds.push(id);
    } else if (/^\d+$/.test(raw)) {
      if (!privateIds.includes(raw)) privateIds.push(raw);
    }
  }

  return {
    privateIds,
    groupIds,
    privateText: privateIds.join(', '),
    groupText: groupIds.join(', '),
  };
}

export function assembleWhitelist(privateInput: unknown, groupInput: unknown): string[] {
  const parseIds = (input: unknown): string[] => {
    if (Array.isArray(input)) {
      return input.map((s) => String(s).replace(/\D/g, '').trim()).filter(Boolean);
    }
    if (typeof input === 'string') {
      return input
        .split(/[,，\n\s]+/)
        .map((s) => s.replace(/\D/g, '').trim())
        .filter(Boolean);
    }
    return [];
  };

  const privates = parseIds(privateInput).map((id) => `private:${id}`);
  const groups = parseIds(groupInput).map((id) => `group:${id}`);

  return Array.from(new Set([...privates, ...groups]));
}

export function parseWhitelist(raw: unknown): string[] {
  if (!raw) return [];

  // 若传入的是配置对象（带有 whitelistPrivate 或 whitelistGroup）
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const cfg = raw as Record<string, unknown>;
    const list: string[] = [];
    if (cfg.whitelistPrivate || cfg.whitelistGroup) {
      list.push(...assembleWhitelist(cfg.whitelistPrivate, cfg.whitelistGroup));
    }
    if (cfg.whitelist) {
      list.push(...parseWhitelist(cfg.whitelist));
    }
    return Array.from(new Set(list));
  }

  if (Array.isArray(raw)) {
    const list: string[] = [];
    for (const item of raw) {
      const str = String(item).trim();
      if (!str) continue;
      if (str.startsWith('private:') || str.startsWith('group:')) {
        list.push(str);
      } else if (/^\d+$/.test(str)) {
        list.push(`private:${str}`);
      }
    }
    return Array.from(new Set(list));
  }

  if (typeof raw === 'string') {
    const items = raw.split(/[,，\n\s]+/).map((s) => s.trim()).filter(Boolean);
    const list: string[] = [];
    for (const item of items) {
      if (item.startsWith('private:') || item.startsWith('group:')) {
        list.push(item);
      } else if (/^\d+$/.test(item)) {
        list.push(`private:${item}`);
      }
    }
    return Array.from(new Set(list));
  }

  return [];
}

/** 访问令牌脱敏：日志与状态返回一律用它，绝不输出原文。 */
export function maskToken(token: string | undefined | null): string {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) return '';
  if (value.length <= 4) return '*'.repeat(value.length);
  const head = value.slice(0, 2);
  const tail = value.slice(-3);
  return `${head}****${tail}`;
}

/** 基础层：日常只需要这几项。 */
function basicConfigGroup(): ConfigGroup {
  return {
    id: `world:${PROACTIVE_WORLD_ID}`,
    owner: `world:${PROACTIVE_WORLD_ID}`,
    schema: {
      type: 'object',
      title: 'QQ主动搭话 · 基础设置',
      description: '日常调这几项就够了：要不要主动说话、对谁说话、一天最多说几次。',
      properties: {
        // 模式切换放在面板最前面；它决定本扩展走哪条发信链路，改完需重启本 World。
        [`worlds.${PROACTIVE_WORLD_ID}.outboundMode`]: {
          type: 'string',
          title: '发信通道',
          description:
            'builtin = 自建 OneBot 直发（qq-final 在用）；external = 交给别的 World 的发信工具；' +
            'bridge = QQ 收发已交给 AstrBot 侧的桥接管，改由模型调 astrbot_send_message 经桥发回。' +
            '改完需重启本 World 才生效。',
          enum: ['builtin', 'external', 'bridge'],
          'x-hot': false,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.enabled`]: {
          type: 'boolean',
          title: '允许它主动找你说话',
          description: '默认关闭。开启前先把下面「能主动找的 QQ 号」填上，否则它谁都不会找。',
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.mode`]: {
          type: 'string',
          title: '对谁主动说话',
          description: '私聊 = 只找好友；群聊 = 只在群里说；都要 = 两种都算。默认只找私聊。',
          enum: ['private', 'group', 'all'],
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.whitelistPrivate`]: {
          type: 'string',
          title: '能主动找的 QQ 号',
          description: '只填数字，多个用逗号或换行分开。留空 = 谁都不主动找。',
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.whitelistGroup`]: {
          type: 'string',
          title: '能主动说话的群号',
          description: '只填数字，多个用逗号或换行分开。留空 = 不在任何群里主动说话。',
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.dailyQuota`]: {
          type: 'integer',
          title: '每天最多主动找你几次',
          description: '默认 20 次。说完就休息到第二天。',
          minimum: 1,
          maximum: 100,
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.unrepliedThreshold`]: {
          type: 'integer',
          title: '连着几次没回就先不说',
          description: '默认 3 次。对方一回话就重新算。',
          minimum: 1,
          maximum: 10,
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.privateMinIntervalMin`]: {
          type: 'integer',
          title: '对同一个人最快多久说一次（分钟）',
          description: '默认 60 = 最快 1 小时才找同一个人说一次。',
          minimum: 1,
          maximum: 1440,
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.privateMaxIntervalMin`]: {
          type: 'integer',
          title: '对同一个人最久隔多久说一次（分钟）',
          description: '默认 360 = 大概 6 小时。和上一项一起决定随机范围。',
          minimum: 1,
          maximum: 2880,
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.groupMinIntervalMin`]: {
          type: 'integer',
          title: '对同一个群最快多久说一次（分钟）',
          description: '默认 180 = 最快 3 小时才在同一个群开口。',
          minimum: 1,
          maximum: 2880,
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.groupMaxIntervalMin`]: {
          type: 'integer',
          title: '对同一个群最久隔多久说一次（分钟）',
          description: '默认 720 = 大概 12 小时。',
          minimum: 1,
          maximum: 4320,
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.routineEnabled`]: {
          type: 'boolean',
          title: '按作息说话',
          description: '睡觉时间完全不发，午休时间少发。',
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.sleepStart`]: {
          type: 'string',
          title: '几点开始睡（HH:mm）',
          description: '这段时间一条都不发。默认 23:30。',
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.sleepEnd`]: {
          type: 'string',
          title: '几点睡醒（HH:mm）',
          description: '醒后才可能开口。默认 08:00。',
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.lazyStart`]: {
          type: 'string',
          title: '几点开始午休（HH:mm）',
          description: '午休时段说得更少。默认 12:30。',
          'x-hot': true,
        },
        [`worlds.${PROACTIVE_WORLD_ID}.lazyEnd`]: {
          type: 'string',
          title: '几点午休结束（HH:mm）',
          description: '默认 14:00。',
          'x-hot': true,
        },
      },
    },
  };
}

/** 高级层：影响说话表现的分寸项，单独一张卡。 */
function advancedConfigGroup(): ConfigGroup {
  return {
    id: `world:${PROACTIVE_WORLD_ID}:advanced`,
    owner: `world:${PROACTIVE_WORLD_ID}`,
    schema: {
      type: 'object',
      title: 'QQ主动搭话 · 高级设置',
      description: '不确定就保持默认。改动会影响它说话的表现。',
      properties: {
        [`worlds.${PROACTIVE_WORLD_ID}.allowSilence`]: {
          type: 'boolean',
          title: '允许它判断「现在不该打扰」就闭嘴',
          description: '关掉会变成到点必发，可能显得烦。默认开启。',
        },
        [`worlds.${PROACTIVE_WORLD_ID}.withNickname`]: {
          type: 'boolean',
          title: '提示它称呼对方名字',
          description: '关掉会显得生分。默认开启。',
        },
        [`worlds.${PROACTIVE_WORLD_ID}.announceRoutine`]: {
          type: 'boolean',
          title: '作息切换时主动说一句',
          description: '早/午/晚切换时问候一次。关掉更安静。默认开启。',
        },
        [`worlds.${PROACTIVE_WORLD_ID}.promptEnabled`]: {
          type: 'boolean',
          title: '让它知道今天的额度和规矩',
          description: '一般保持开启。关掉后它不知道自己还能说几次。',
        },
        [`worlds.${PROACTIVE_WORLD_ID}.promptText`]: {
          type: 'string',
          title: '自定义说话风格',
          description: '留空用内置风格（自然、不催促、话短）。改动下一轮生效。',
        },
      },
    },
  };
}

/**
 * 面板可见的配置组。
 * 运营/危险项（发信通道、令牌、字段映射、前缀、检查频率）不进面板，避免误改导致静默失效或凭据泄露。
 */
export function proactiveConfigGroups(): ConfigGroup[] {
  return [basicConfigGroup(), advancedConfigGroup()];
}
