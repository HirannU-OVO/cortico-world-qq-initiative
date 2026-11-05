/**
 * 场景化提示词模板与动态情绪阶梯定义
 *
 * 这里是唯一一份来源：长文案（面板/日志/未来扩展用）和短文案（塞进每轮 nudge，受 400 字符上限约束）
 * 放在一起，避免 nudge_builder 再自己重写一套、两边慢慢漂掉。
 */
import type { ProactiveScene, RoutinePhase } from '../types.ts';

export interface EmotionLadder {
  unrepliedCount: number;
  /** 完整语气引导。 */
  toneGuidance: string;
  /** 压进每轮 nudge 的短版，上限 24 字左右；0 次未回时留空。 */
  short: string;
}

export const EMOTION_LADDERS: Record<'first' | 'second' | 'final', EmotionLadder> = {
  first: {
    unrepliedCount: 0,
    toneGuidance: '这是本次互动开端。态度轻松自然、富有分享欲，结合最近聊过的话题或此时的心境自然开启对话。',
    short: '',
  },
  second: {
    unrepliedCount: 1,
    toneGuidance: '对方上次尚未回复。态度温和关切、不带施压感，体贴地问问对方是否在忙，或者分享一句简短有爱的小发现。',
    short: '他上一条还没回，语气放软，别施压',
  },
  final: {
    unrepliedCount: 2,
    toneGuidance: '对方已连续两次未回复。保持极其体贴包容的口吻，留下一句暖心关怀或提醒好好休息即可，切勿继续连环追问；若对方在忙不用回。',
    short: '连着两条没回了，只留一句关怀就收，别再追',
  },
};

export function getEmotionGuidance(unrepliedCount: number): string {
  if (unrepliedCount <= 0) return EMOTION_LADDERS.first.toneGuidance;
  if (unrepliedCount === 1) return EMOTION_LADDERS.second.toneGuidance;
  return EMOTION_LADDERS.final.toneGuidance;
}

/** 短版阶梯：0 次未回时返回空串，调用方别往 nudge 里塞空话。 */
export function getToneShort(unrepliedCount: number): string {
  if (unrepliedCount <= 0) return '';
  if (unrepliedCount === 1) return EMOTION_LADDERS.second.short;
  return EMOTION_LADDERS.final.short;
}

export const SCENE_DESCRIPTIONS: Record<ProactiveScene, string> = {
  idle_chat: '日常闲聊／偶发分享（检测到会话较长静默，闲暇时主动找对方搭话）',
  routine_wake: '清晨早安（刚睡醒、舒展身心，向对方道早安）',
  routine_noon: '午间小憩（午休时光，提醒对方吃午饭或打个盹）',
  routine_sleep: '深夜晚安（准备入睡，向对方道一声温馨晚安）',
};

/** 进 nudge 的短场景名（同 SCENE_DESCRIPTIONS，压到四个字）。 */
export const SCENE_SHORT: Record<ProactiveScene, string> = {
  idle_chat: '日常闲聊',
  routine_wake: '早安问候',
  routine_noon: '午休关心',
  routine_sleep: '晚安道别',
};

export const PHASE_SHORT: Record<RoutinePhase, string> = {
  WAKE: '清醒时段',
  NOON_LAZY: '午休时段',
  NIGHT_QUIET: '深夜安静期',
  SLEEP: '深睡时段',
};

export const PHASE_MOODS: Record<RoutinePhase, string> = {
  WAKE: '清醒活跃、充满活力与日常陪伴感',
  NOON_LAZY: '慵懒惬意、轻声细语、带有一丝困倦的小轻松',
  NIGHT_QUIET: '安宁柔和、恬淡舒适，适合夜深时的低语倾听',
  SLEEP: '熟睡状态（非必要不打扰）',
};
