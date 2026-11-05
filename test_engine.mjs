/**
 * Phase 2 核心引擎单元自测脚本
 * 验证：
 * 1. StateManager 状态持久化与跨天重置；
 * 2. ActivityMonitor 消息采集与静默时间计算；
 * 3. OutboundAdapter 工具契约匹配；
 * 4. QuotaManager 三阶段事务（Pledge -> Verify / Rollback）；
 * 5. Scheduler 随机扰动与加权打分挑选。
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateManager } from './src/state/manager.ts';
import { ActivityMonitor } from './src/monitor/activity.ts';
import { OutboundAdapter } from './src/outbound/adapter.ts';
import { QuotaManager } from './src/state/quota.ts';
import { Scheduler } from './src/engine/scheduler.ts';
import { PROACTIVE_DEFAULTS } from './src/config.ts';

const tempDir = mkdtempSync(join(tmpdir(), 'proactive-test-'));

try {
  console.log('--- [Test 1] StateManager & Rollover ---');
  const sm = new StateManager(tempDir);
  assert.strictEqual(sm.dailyCount, 0);
  sm.incrementDailyCount();
  assert.strictEqual(sm.dailyCount, 1);

  console.log('--- [Test 2] ActivityMonitor ---');
  const am = new ActivityMonitor(sm);
  const t0 = 1000000;
  am.observeMessage({
    address: 'private:123456',
    kind: 'private',
    isFromUser: true,
    label: '羽羽',
    ts: t0,
  });

  const session = am.getSessionActivity('private:123456');
  assert.ok(session);
  assert.strictEqual(session.lastUserMessageTime, t0);
  assert.strictEqual(session.unrepliedCount, 0);

  console.log('--- [Test 3] OutboundAdapter Contract ---');
  const adapter = new OutboundAdapter({
    toolName: 'qq_send',
    toField: 'to',
    textField: 'text',
  });
  const matchResult = adapter.verifyToolExecution('qq_send', { to: 'private:123456', text: '你好呀' }, 'private:123456');
  assert.strictEqual(matchResult.matched, true);
  assert.strictEqual(matchResult.text, '你好呀');

  const mismatchResult = adapter.verifyToolExecution('other_tool', { to: 'private:123456', text: '你好' });
  assert.strictEqual(mismatchResult.matched, false);

  console.log('--- [Test 4] QuotaManager 3-Stage Transaction ---');
  const qm = new QuotaManager(sm, am);
  // 真实配置形状：只配 whitelistPrivate（老 bug 就是只读 cfg.whitelist 导致白名单恒空）
  const cfg = {
    ...PROACTIVE_DEFAULTS,
    enabled: true,
    dailyQuota: 5,
    unrepliedThreshold: 3,
    whitelist: '',
    whitelistPrivate: '123456',
    whitelistGroup: '',
  };

  // 1. Pledge
  assert.strictEqual(qm.canTrigger('private:123456', 'private', cfg).allowed, true);
  const pledged = qm.pledge('private:123456', 'private', 'idle_chat', 'qq_initiative_send', '羽羽');
  assert.strictEqual(pledged.address, 'private:123456');
  assert.ok(pledged.id.startsWith('p-'));
  assert.ok(qm.activePledge);

  // 2. Rollback test (静默回滚，配额无损)
  qm.rollbackPledge('user_silence', pledged.id);
  assert.strictEqual(qm.activePledge, null);
  assert.strictEqual(sm.dailyCount, 1); // 依然保持之前的 1，未虚扣
  assert.strictEqual(sm.getSession('private:123456')?.unrepliedCount, 0); // 未回复数不增

  // 3. Pledge -> Verify test (发信核销，配额扣除，未回复数+1)
  const pledged2 = qm.pledge('private:123456', 'private', 'idle_chat', 'qq_initiative_send', '羽羽');
  const verified = qm.verifyOutboundSent('private:123456', '主动问候内容', pledged2.id);
  assert.strictEqual(verified, true);
  assert.strictEqual(sm.dailyCount, 2); // 正式自增
  assert.strictEqual(sm.getSession('private:123456')?.unrepliedCount, 1); // 未回复数+1

  // 3.1 迟到回执不得结算新质押（P1-9）
  const pledged3 = qm.pledge('private:123456', 'private', 'idle_chat', 'qq_initiative_send', '羽羽');
  assert.strictEqual(qm.verifyOutboundSent('private:123456', '迟到回执', 'p-stale-1'), false);
  assert.ok(qm.activePledge, '迟到回执不能清掉在途质押');
  qm.rollbackPledge('test_cleanup', pledged3.id);
  assert.strictEqual(qm.activePledge, null);

  // 3.2 白名单硬排除 + force 不得越过白名单（P1-6）
  assert.strictEqual(qm.canTrigger('private:999999', 'private', cfg, { force: true }).allowed, false);

  // 3.3 DND 时段 force 也不得越过
  assert.strictEqual(
    qm.canTrigger('private:123456', 'private', cfg, { force: true, dndActive: true }).allowed,
    false
  );

  console.log('--- [Test 5] Scheduler & Pick Scoring ---');
  const scheduler = new Scheduler(am, qm);
  const interval = scheduler.getRandomIntervalMs(60, 120);
  assert.ok(interval >= 60 * 60 * 1000 && interval <= 120 * 60 * 1000);

  // 重设 session 时间用于调度测试
  const simNow = t0 + 100 * 60 * 1000;
  sm.updateSession('private:123456', (s) => {
    s.lastUserMessageTime = t0;
    s.lastBotMessageTime = t0;
    s.lastProactiveSentTime = 0;
    s.unrepliedCount = 0;
  });
  const sessionObj = sm.getSession('private:123456');
  assert.ok(sessionObj);
  const candidate = scheduler.scoreCandidate(sessionObj, cfg, {}, simNow);
  assert.ok(candidate);
  assert.ok(candidate.score > 0);

  // 5.2 白名单硬排除测试：未在白名单的会话必须返回 null
  const nonWhitelistedSession = sm.getOrCreateSession('private:999999', 'private');
  const rejectedCandidate = scheduler.scoreCandidate(nonWhitelistedSession, cfg, {}, simNow);
  assert.strictEqual(rejectedCandidate, null);

  // 5.3 严格地址归一化测试：不同类型即使数字相同也绝不混淆
  assert.strictEqual(adapter.matchesAddress('private:123456', 'qq:private:123456'), true);
  assert.strictEqual(adapter.matchesAddress('group:123456', 'private:123456'), false);

  console.log('>>> 全部测试断言通过！Phase 2 核心调度引擎与自愈状态机完整验证成功！<<<');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
