/**
 * Phase 3 作息状态机与 Nudge 提示构建器单元自测脚本
 * 验证：
 * 1. RoutineCoordinator 4阶段生理相计算与跨午夜深睡期判定；
 * 2. 睡眠免打扰守卫（isDndActive）与边界跃迁检测（checkTransition）；
 * 3. EMOTION_LADDERS 情绪阶梯递进（unreplied 0 / 1 / 2+）；
 * 4. NudgeBuilder 强约束输出三元组【目标名称】【投递地址 to="..."】【会话类型】及反向自省指导。
 */
import assert from 'node:assert';

import { RoutineCoordinator } from './src/engine/routine.ts';
import { NudgeBuilder } from './src/prompt/nudge_builder.ts';
import { getEmotionGuidance } from './src/prompt/templates.ts';
import { PROACTIVE_DEFAULTS } from './src/config.ts';

console.log('--- [Test 1] RoutineCoordinator Phase & DND ---');
const routine = new RoutineCoordinator();
const cfg = {
  ...PROACTIVE_DEFAULTS,
  routineEnabled: true,
  sleepStart: '23:30',
  sleepEnd: '08:00',
  lazyStart: '12:30',
  lazyEnd: '14:00',
};

// 1.1 测试深睡期（跨午夜：凌晨 02:00 与 夜晚 23:45）
const d2am = new Date('2026-11-02T02:00:00');
assert.strictEqual(routine.getPhase(cfg, d2am), 'SLEEP');
assert.strictEqual(routine.isDndActive(cfg, d2am), true);

const d1145pm = new Date('2026-11-02T23:45:00');
assert.strictEqual(routine.getPhase(cfg, d1145pm), 'SLEEP');
assert.strictEqual(routine.isDndActive(cfg, d1145pm), true);

// 1.2 测试午休惬意期（13:00）
const d1pm = new Date('2026-11-02T13:00:00');
assert.strictEqual(routine.getPhase(cfg, d1pm), 'NOON_LAZY');
assert.strictEqual(routine.isDndActive(cfg, d1pm), false);

// 1.3 测试清醒活跃期（10:00）
const d10am = new Date('2026-11-02T10:00:00');
assert.strictEqual(routine.getPhase(cfg, d10am), 'WAKE');
assert.strictEqual(routine.isDndActive(cfg, d10am), false);

// 1.4 测试边界跃迁检测
const transWake = routine.checkTransition('SLEEP', 'WAKE', true);
assert.strictEqual(transWake?.scene, 'routine_wake');

const transNoon = routine.checkTransition('WAKE', 'NOON_LAZY', true);
assert.strictEqual(transNoon?.scene, 'routine_noon');

const transSleep = routine.checkTransition('NIGHT_QUIET', 'SLEEP', true);
assert.strictEqual(transSleep?.scene, 'routine_sleep');

console.log('--- [Test 2] Emotion Ladder (unreplied 0 / 1 / 2+) ---');
assert.ok(getEmotionGuidance(0).includes('轻松自然'));
assert.ok(getEmotionGuidance(1).includes('温和关切'));
assert.ok(getEmotionGuidance(2).includes('体贴包容'));
assert.ok(getEmotionGuidance(3).includes('体贴包容'));

console.log('--- [Test 3] NudgeBuilder Triad & Prompt ---');
const testSession = {
  address: 'private:123456789',
  kind: 'private',
  label: '羽羽',
  lastUserMessageTime: Date.now() - 3600000,
  lastBotMessageTime: Date.now() - 3600000,
  lastProactiveSentTime: 0,
  unrepliedCount: 1,
  recentTopics: [],
};

const nudge = NudgeBuilder.build({
  session: testSession,
  scene: 'idle_chat',
  routinePhase: 'WAKE',
  outboundTool: 'qq_initiative_send',
  withNickname: true,
  allowSilence: true,
});

// 验证目标与投递地址可被模型原样取用
assert.ok(nudge.includes('现在主动找 羽羽 说句话'));
assert.ok(nudge.includes('to = "private:123456789"'));

// 验证发信渠道指引、中性措辞、静默选项与长度上限（V21）
console.log('ACTUAL NUDGE:\n', nudge);
assert.ok(nudge.includes('qq_initiative_send'));
assert.ok(nudge.includes('to = "private:123456789"'));
assert.ok(nudge.includes('别换发送渠道，系统只认这个工具的回执'));
assert.ok(nudge.includes('end_turn'));
assert.strictEqual([...nudge].length <= 400, true, `nudge 长度 ${[...nudge].length}`);

console.log('>>> 全部测试断言通过！Phase 3 作息状态机与 Nudge 提示构建器完整验证成功！<<<');
