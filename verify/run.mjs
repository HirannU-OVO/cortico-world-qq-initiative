/**
 * 方案第九章 9.4 验收清单（V1–V16）的可执行自测入口。
 *
 * 原则（对应 9.5 防复发）：
 * - 不直接调用被验证的内部函数：入站走「真实事件库 + 定时器 + tick()」，发信走「真实 HTTP + 工具 handler」，
 *   结算走「onEventsSettled → onTurnEnded」钩子，配额走公开查询面。
 * - 宿主用实现真实 WorldHost 接口的替身（事件库为内存版 EventStoreReader，行为与 Core 一致），
 *   被验证的是插件自身，不是替身。
 * - 发信通道用本地 OneBot HTTP 仿真器：成功/失败由真实 HTTP 状态与 retcode 决定，不靠打桩返回值。
 *
 * 用法：node verify/run.mjs            （全部）
 *       node verify/run.mjs V9 V10     （只跑指定项）
 */
import assert from 'node:assert';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProactiveWorld, parseTs } from '../src/index.ts';
import { PROACTIVE_DEFAULTS, parseWhitelist } from '../src/config.ts';
import { NudgeBuilder } from '../src/prompt/nudge_builder.ts';

const results = [];
let current = '';

function check(id, ok, detail) {
  results.push({ id, current, ok: !!ok, detail: String(detail) });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${id} ${current} :: ${detail}`);
  if (!ok) process.exitCode = 1;
}

function section(id, title) {
  current = id;
  console.log(`\n===== ${id} ${title} =====`);
}

// ---------------------------------------------------------------- OneBot 仿真器

async function startOneBotFake() {
  const state = { mode: 'ok', calls: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = {};
      }
      state.calls.push({ path: url.pathname, token: url.searchParams.get('access_token'), payload });
      const reply = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (state.mode === 'fail') {
        reply({ status: 'failed', retcode: 100, data: null, wording: '发送失败（仿真）' });
        return;
      }
      const id = url.pathname.includes('group') ? payload.group_id : payload.user_id;
      reply({ status: 'ok', retcode: 0, data: { message_id: 900000 + state.calls.length, target: id } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------------------------------------------------------------- 宿主替身

function createHost(dataDir) {
  let cursorSeq = 0;
  const events = [];
  const pushed = [];
  const logs = [];
  const append = (e) => {
    const saved = { cursor: ++cursorSeq, origin: 'external', ...e };
    events.push(saved);
    return saved;
  };
  const store = {
    get: (c) => events.find((e) => e.cursor === c),
    latestCursor: () => cursorSeq,
    range: (q) => {
      const from = q.fromCursor ?? 0;
      const to = q.toCursor ?? Number.MAX_SAFE_INTEGER;
      let rows = events.filter((e) => e.cursor >= from && e.cursor <= to);
      if (q.limit) rows = rows.slice(-q.limit);
      return rows;
    },
    around: (c, before, after) => events.filter((e) => e.cursor >= c - before && e.cursor <= c + after),
    grep: () => [],
  };
  const host = {
    store,
    append,
    async pushEvent(e, opts) {
      const saved = { cursor: ++cursorSeq, origin: e.origin ?? 'external', ...e, opts };
      pushed.push(saved);
      events.push(saved);
      return saved;
    },
    log: {
      debug: (m, f) => logs.push({ level: 'debug', msg: m, fields: f }),
      info: (m, f) => logs.push({ level: 'info', msg: m, fields: f }),
      warn: (m, f) => logs.push({ level: 'warn', msg: m, fields: f }),
      error: (m, f) => logs.push({ level: 'error', msg: m, fields: f }),
    },
    pushed,
    logs,
    dataDir,
  };
  return host;
}

function createCtx(dataDir, cfg, persisted) {
  return {
    id: 'qq-initiative',
    cfg,
    timezone: 'Asia/Shanghai',
    botName: '肥鸾鱼',
    botDir: dataDir,
    packageDir: dataDir,
    dataDir,
    repoRoot: dataDir,
    secret: () => '',
    persist(patch) {
      persisted.push(patch);
      const file = join(dataDir, 'config.json');
      let base = {};
      if (existsSync(file)) {
        try {
          base = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          base = {};
        }
      }
      base.worlds = base.worlds ?? {};
      base.worlds['qq-initiative'] = { ...(base.worlds['qq-initiative'] ?? {}), ...patch };
      writeFileSync(file, JSON.stringify(base, null, 2), 'utf8');
    },
    async restart() {},
  };
}

function baseConfig(overrides = {}) {
  return {
    ...PROACTIVE_DEFAULTS,
    enabled: true,
    // 真实配置形状：只有 whitelistPrivate，whitelist 为空串（历史 P0-2 就死在这里）
    whitelist: '',
    whitelistPrivate: '123456789',
    whitelistGroup: '',
    outboundMode: 'builtin',
    outboundTool: 'qq_initiative_send',
    privateMinIntervalMin: 1,
    groupMinIntervalMin: 1,
    dailyQuota: 20,
    ...overrides,
  };
}

/** 发信工具回执是给模型看的中文文本：成功=「成功已发送到」，失败=[send failed] 前缀。 */
function parseSendResult(raw) {
  const text = typeof raw === 'string' ? raw : (raw?.text ?? '');
  const ok = text.startsWith('成功已发送到');
  const m = text.match(/message_id=([0-9]+)/);
  return {
    ok,
    text,
    messageId: m ? Number(m[1]) : undefined,
    error: ok ? undefined : text.replace(/^\[send failed\]\s*/, ''),
  };
}

/** 面板 / 工具可能返回 JSON 字符串，也可能返回纯文本。 */
function parseJsonish(raw) {
  const text = typeof raw === 'string' ? raw : (raw?.text ?? '');
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const toolByName = (world, name) => {
  const tool = world.tools().find((t) => t.name === name);
  assert.ok(tool, `工具不存在：${name}`);
  return tool;
};

const readState = (dir) => JSON.parse(readFileSync(join(dir, 'qq-initiative-v2.json'), 'utf8'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 主流程

const only = process.argv.slice(2).filter((a) => /^V\d+$/.test(a));
const want = (id) => !only.length || only.includes(id);

const root = mkdtempSync(join(tmpdir(), 'qq-initiative-acceptance-'));
const onebot = await startOneBotFake();

try {
  // ============================================================ V8 白名单读取
  if (want('V8')) {
    section('V8', '只配 whitelistPrivate 时 parseWhitelist(cfg) 能取到号码');
    const list = parseWhitelist({ whitelist: '', whitelistPrivate: '123456789', whitelistGroup: '' });
    check('V8', list.length === 1 && list[0] === 'private:123456789', `解析结果 ${JSON.stringify(list)}`);

    const multi = parseWhitelist({ whitelistPrivate: '123456789, 222222222', whitelistGroup: '987654321' });
    check(
      'V8',
      multi.length === 3 && multi.includes('group:987654321'),
      `混合配置解析 ${JSON.stringify(multi)}`
    );
  }

  // ============================================================ V1 启动日志
  let host;
  let world;
  let cfg;
  let persisted;
  {
    const dir = join(root, 'v1');
    cfg = baseConfig({ outboundHttpUrl: onebot.baseUrl, outboundHttpToken: 'test-token' });
    persisted = [];
    host = createHost(dir);
    // 预置两条历史事件：起点 cursor 应当是非 0，且历史消息不得被重放
    host.append({ type: 'qq.message', ts: new Date().toISOString(), source: 'qq', text: '历史1', senderKey: 'private:555', meta: { conv: 'private:555' } });
    host.append({ type: 'qq.message', ts: new Date().toISOString(), source: 'qq', text: '历史2', senderKey: 'private:555', meta: { conv: 'private:555' } });
    world = new ProactiveWorld(createCtx(dir, cfg, persisted), { tickIntervalMs: 60_000, selfCheckDelayMs: 5_000 });
    await world.start(host);

    if (want('V1')) {
      section('V1', '启动日志：info 说人话，debug 保留 tick 与起点 cursor');
      const infoLine = host.logs.find((l) => l.level === 'info' && l.msg.includes('[主动搭话]'))?.msg ?? '';
      const debugLine = host.logs.find((l) => l.level === 'debug' && l.msg.includes('技术细节'))?.msg ?? '';
      const m = debugLine.match(/检查间隔=(\d+) 秒.*读取起点=(\d+)/);
      check('V1', /已启动：今天已说 0\/20 次/.test(infoLine), infoLine || '（无 info 日志）');
      check('V1', !!m && Number(m[1]) === 60 && Number(m[2]) === 2, debugLine || '（无 debug 日志）');
      check('V1', readState(dir).sessions['private:555'] === undefined, '历史事件未被重放（无 private:555 会话）');
    }
  }

  const dir = join(root, 'v1');
  const dispatch = async (address, kind, scene = 'idle_chat') => {
    const ok = await world.dispatchProactiveTurn(address, kind, scene);
    return ok;
  };

  // ============================================================ V2 入站观测（定时器驱动）
  if (want('V2')) {
    section('V2', '发一条 QQ 消息后 ≤90 秒 lastUserMessageTime 变为非 0');
    // 用真实定时器路径：tickIntervalMs 缩短，但不手动调 tick，证明周期真的被驱动
    const dir2 = join(root, 'v2');
    const cfg2 = baseConfig({ outboundHttpUrl: onebot.baseUrl });
    const persisted2 = [];
    const host2 = createHost(dir2);
    const world2 = new ProactiveWorld(createCtx(dir2, cfg2, persisted2), { tickIntervalMs: 60, selfCheckDelayMs: 200 });
    await world2.start(host2);
    host2.append({
      type: 'qq.message',
      ts: new Date('2026-11-02T21:00:00+08:00').toISOString(),
      source: 'qq',
      origin: 'external',
      text: '在吗？',
      senderKey: 'private:168000001',
      meta: { conv: 'private:168000001', card: '测试好友', role: 'user' },
    });
    await wait(400); // 等真实定时器跑过至少一个 tick
    const st = readState(dir2);
    // 真实机号不写进测试产物，这里用假号
    const sess = st.sessions['private:168000001'];
    check('V2', !!sess && sess.lastUserMessageTime > 0, `lastUserMessageTime=${sess?.lastUserMessageTime ?? 'n/a'}`);
    check('V2', sess?.label === '测试好友', `label=${sess?.label ?? 'n/a'}`);

    // 自回灌（meta.self）不得算用户发言
    host2.append({
      type: 'qq.message',
      ts: new Date().toISOString(),
      source: 'qq',
      origin: 'internal',
      text: '（自回灌）',
      senderKey: 'private:168000001',
      meta: { conv: 'private:168000001', role: 'assistant', self: true },
    });
    const before = readState(dir2).sessions['private:168000001'].lastUserMessageTime;
    await wait(400);
    const after = readState(dir2).sessions['private:168000001'].lastUserMessageTime;
    check('V2', before === after, `自回灌未改动 lastUserMessageTime（${before} -> ${after}）`);
    await world2.stop();
  }

  // ============================================================ V6 / V7 白名单可见性
  if (want('V6')) {
    section('V6', 'qq_initiative_status 的白名单数量与配置一致');
    const statusTool = toolByName(world, 'qq_initiative_status');
    const raw = await statusTool.handler({}, {});
    const parsed = JSON.parse(typeof raw === 'string' ? raw : raw.text);
    check('V6', parsed.whitelistCount === 1 && parsed.whitelist[0] === 'private:123456789', `whitelist=${JSON.stringify(parsed.whitelist)}`);
  }

  if (want('V7')) {
    section('V7', '环境提示词里的白名单不是「（未配置）」');
    const vars = world.envPromptVars();
    check('V7', vars.proactiveWhitelist === 'private:123456789', `proactiveWhitelist=${vars.proactiveWhitelist}`);
  }

  // ============================================================ V3 触发 → pledged → 非 silence_rollback
  if (want('V3')) {
    section('V3', 'proactive_trigger 后出现 pledged，且随后不是 silence_rollback');
    const triggerTool = toolByName(world, 'qq_initiative_trigger');
    const raw = await triggerTool.handler({ address: 'private:123456789' }, {});
    const res = JSON.parse(typeof raw === 'string' ? raw : raw.text);
    check('V3', res.status === 'pledged' && !!res.pledged?.id, `trigger=${res.status} pledge=${res.pledged?.id}`);
    const pushed = host.pushed.at(-1);
    check('V3', pushed?.type === 'im.proactive.turn' && pushed?.source === 'qq-initiative', `pushEvent type=${pushed?.type} source=${pushed?.source}`);
    const pledgeId = res.pledged.id;

    // 钩子链：投递成功 → 回合内真实发信 → 回合结束
    world.onEventsSettled([pushed], 'delivered');
    const sendTool = toolByName(world, 'qq_initiative_send');
    const sendRaw = await sendTool.handler({ to: 'private:123456789', text: '在忙吗？突然想起你。' }, {});
    const sendRes = parseSendResult(sendRaw);
    world.onTurnEnded();

    const audit = readState(dir);
    const events = audit.auditLog.map((a) => a.event);
    check('V3', events.includes('pledged'), `audit=${events.join(',')}`);
    check('V3', events.includes('sent') && !events.includes('silence_rollback'), `结算结果 audit=${events.join(',')}`);
    check('V3', sendRes.ok === true && typeof sendRes.messageId === 'number', `真实回执 message_id=${sendRes.messageId}`);
    check('V3', onebot.state.calls.at(-1)?.payload.user_id === 123456789, `OneBot 收到 user_id=${onebot.state.calls.at(-1)?.payload.user_id}`);
    check('V3', audit.sessions['private:123456789'].unrepliedCount === 1, `unrepliedCount=${audit.sessions['private:123456789'].unrepliedCount}`);
    world.quotaManager.rollbackPledge('test_reset');
  }

  // ============================================================ V16 recentTopics
  if (want('V16')) {
    section('V16', 'recentTopics 非空，且 nudge 出现「近期已聊」');
    const st = readState(dir);
    const topics = st.sessions['private:123456789']?.recentTopics ?? [];
    check('V16', topics.length > 0, `recentTopics=${JSON.stringify(topics)}`);
    const session = world.stateManager.getSession('private:123456789');
    const nudge = NudgeBuilder.build({
      session,
      scene: 'idle_chat',
      routinePhase: 'WAKE',
      outboundTool: world.outboundAdapter.toolName,
      withNickname: true,
      allowSilence: true,
    });
    check('V16', nudge.includes('近期已聊'), `nudge 含「近期已聊」=${nudge.includes('近期已聊')}`);
  }

  // ============================================================ V9 错发目标
  if (want('V9')) {
    section('V9', '把消息发给另一个地址 → target_mismatch，配额不记在质押方');
    const before = readState(dir).dailyCount;
    // 上一项刚发过信，最小间隔会拦住；这里用 force 只放宽配额与间隔（白名单仍生效）
    await world.dispatchProactiveTurn('private:123456789', 'private', 'idle_chat', undefined, undefined, true);
    const pledge = world.quotaManager.activePledge;
    const pushed = host.pushed.at(-1);
    world.onEventsSettled([pushed], 'delivered');
    const sendTool = toolByName(world, 'qq_initiative_send');
    await sendTool.handler({ to: 'private:777777777', text: '发错人了' }, {});
    world.onTurnEnded();
    const st = readState(dir);
    const lastAudit = st.auditLog.at(-1);
    check('V9', st.auditLog.some((a) => a.event === 'target_mismatch'), `最近审计=${lastAudit?.event}`);
    check('V9', st.dailyCount === before, `dailyCount 未增加（${before} -> ${st.dailyCount}）`);
    check('V9', world.quotaManager.activePledge === null, `质押已释放 pledge=${pledge?.id}`);
  }

  // ============================================================ V10 发送失败不记账
  if (want('V10')) {
    section('V10', '一次发送失败后 dailyCount 与 unrepliedCount 都不增加');
    onebot.state.mode = 'fail';
    const dir3 = join(root, 'v10');
    const cfg3 = baseConfig({ outboundHttpUrl: onebot.baseUrl });
    const host3 = createHost(dir3);
    const world3 = new ProactiveWorld(createCtx(dir3, cfg3, []), { tickIntervalMs: 60_000 });
    await world3.start(host3);
    await world3.dispatchProactiveTurn('private:123456789', 'private');
    host3.pushed.at(-1) && world3.onEventsSettled([host3.pushed.at(-1)], 'delivered');
    const sendTool = toolByName(world3, 'qq_initiative_send');
    const raw = await sendTool.handler({ to: 'private:123456789', text: '这条应该失败' }, {});
    const parsed = parseSendResult(raw);
    world3.onTurnEnded();
    const st = readState(dir3);
    check('V10', parsed.ok === false, `回执 ok=${parsed.ok} error=${parsed.error}`);
    check('V10', st.dailyCount === 0, `dailyCount=${st.dailyCount}`);
    check('V10', (st.sessions['private:123456789']?.unrepliedCount ?? 0) === 0, `unrepliedCount=${st.sessions['private:123456789']?.unrepliedCount}`);
    check('V10', st.auditLog.some((a) => a.event === 'silence_rollback'), `审计=${st.auditLog.map((a) => a.event).join(',')}`);
    onebot.state.mode = 'ok';
    await world3.stop();
  }

  // ============================================================ V11 并发回合归属
  if (want('V11')) {
    section('V11', '宠物正在与 A 对话时触发给 B 的主动搭话 → B 的那次正常记账');
    const dir4 = join(root, 'v11');
    const cfg4 = baseConfig({ outboundHttpUrl: onebot.baseUrl, whitelistPrivate: '123456789, 222222222' });
    const host4 = createHost(dir4);
    const world4 = new ProactiveWorld(createCtx(dir4, cfg4, []), { tickIntervalMs: 60_000 });
    await world4.start(host4);

    await world4.dispatchProactiveTurn('private:222222222', 'private');
    const pledged = world4.quotaManager.activePledge;
    check('V11', !!pledged && pledged.address === 'private:222222222', `质押 ${pledged?.id} -> ${pledged?.address}`);

    // 别的会话（A）那一轮先结束：此时主动事件还没投递，不得回滚 B 的质押
    world4.onTurnEnded();
    check('V11', world4.quotaManager.activePledge?.id === pledged.id, 'A 的回合结束未带走 B 的质押');

    // B 的主动事件投递了，但只是搭进 A 这一轮已经在跑的批：模型没看到它，
    // 这一轮结束时也不得回滚（真实线上就是在这里把自己吃掉过一次）
    world4.onEventsSettled([host4.pushed.at(-1)], 'delivered');
    world4.onTurnEnded();
    check(
      'V11',
      world4.quotaManager.activePledge?.id === pledged.id,
      '事件搭进他人回合时，该回合结束不回滚质押'
    );

    // 下一轮真的起来了（模型阶段出现），这一轮里真实发出
    world4.onRunPhase({ state: 'model', running: [], enteredAt: new Date().toISOString() });
    const sendTool = toolByName(world4, 'qq_initiative_send');
    await sendTool.handler({ to: 'private:222222222', text: 'B 的主动搭话' }, {});
    world4.onTurnEnded();

    const st = readState(dir4);
    check('V11', st.dailyCount === 1, `dailyCount=${st.dailyCount}`);
    check('V11', st.sessions['private:222222222']?.unrepliedCount === 1, `B unrepliedCount=${st.sessions['private:222222222']?.unrepliedCount}`);
    check('V11', st.auditLog.some((a) => a.event === 'sent' && a.target === 'private:222222222'), `审计=${st.auditLog.map((a) => a.event + ':' + a.target).join(',')}`);
    await world4.stop();
  }

  // ============================================================ V12 poke 不清零
  if (want('V12')) {
    section('V12', '群里发一条 poke → 该会话 unrepliedCount 不被清零');
    const dir5 = join(root, 'v12');
    const cfg5 = baseConfig({ outboundHttpUrl: onebot.baseUrl, whitelistGroup: '987654321', mode: 'all' });
    const host5 = createHost(dir5);
    const world5 = new ProactiveWorld(createCtx(dir5, cfg5, []), { tickIntervalMs: 60_000 });
    await world5.start(host5);

    // 先造一个"主动已发、对方未回"的会话
    await world5.dispatchProactiveTurn('group:987654321', 'group');
    world5.onEventsSettled([host5.pushed.at(-1)], 'delivered');
    await toolByName(world5, 'qq_initiative_send').handler({ to: 'group:987654321', text: '群里冒个泡' }, {});
    world5.onTurnEnded();
    const before = readState(dir5).sessions['group:987654321'].unrepliedCount;
    check('V12', before === 1, `初始 unrepliedCount=${before}`);

    // poke / react / recall / member / reminder 全来一遍
    for (const type of ['qq.poke', 'qq.react', 'qq.recall', 'qq.member', 'qq.reminder']) {
      host5.append({
        type,
        ts: new Date().toISOString(),
        source: 'qq',
        origin: 'external',
        text: '弱信号',
        senderKey: 'group:987654321',
        meta: { conv: 'group:987654321' },
      });
    }
    await world5.tick();
    const st = readState(dir5);
    check('V12', st.sessions['group:987654321'].unrepliedCount === before, `poke 后 unrepliedCount=${st.sessions['group:987654321'].unrepliedCount}`);
    await world5.stop();
  }

  // ============================================================ V13 / V14 force 边界
  if (want('V13')) {
    section('V13', 'force=true 对非白名单地址被拒绝');
    const triggerTool = toolByName(world, 'qq_initiative_trigger');
    const raw = await triggerTool.handler({ address: 'private:999999999', force: true }, {});
    const res = JSON.parse(typeof raw === 'string' ? raw : raw.text);
    check('V13', res.status === 'rejected' && /白名单/.test(res.reason ?? ''), `reason=${res.reason}`);
  }

  if (want('V14')) {
    section('V14', '深夜（SLEEP 时段）force=true 被拒绝');
    const dir6 = join(root, 'v14');
    // 用当前时刻构造一个必然处于 SLEEP 的作息窗口：sleepStart=00:00、sleepEnd=23:59
    const cfg6 = baseConfig({
      outboundHttpUrl: onebot.baseUrl,
      sleepStart: '00:00',
      sleepEnd: '23:59',
      routineEnabled: true,
    });
    const host6 = createHost(dir6);
    const world6 = new ProactiveWorld(createCtx(dir6, cfg6, []), { tickIntervalMs: 60_000 });
    await world6.start(host6);
    const raw = await toolByName(world6, 'qq_initiative_trigger').handler(
      { address: 'private:123456789', force: true },
      {}
    );
    const res = JSON.parse(typeof raw === 'string' ? raw : raw.text);
    check('V14', res.status === 'rejected' && /免打扰/.test(res.reason ?? ''), `reason=${res.reason}`);
    await world6.stop();
  }

  // ============================================================ V15 面板白名单落盘
  if (want('V15')) {
    section('V15', '面板改白名单 → 重启后仍在（config.json 已写入）');
    const dir7 = join(root, 'v15');
    const cfg7 = baseConfig({ outboundHttpUrl: onebot.baseUrl });
    const persisted7 = [];
    const host7 = createHost(dir7);
    const world7 = new ProactiveWorld(createCtx(dir7, cfg7, persisted7), { tickIntervalMs: 60_000 });
    await world7.start(host7);
    await world7.webUi().invoke('dashboard', 'update_whitelist', [{ privateText: '123456789, 222222222', groupText: '' }]);

    const written = JSON.parse(readFileSync(join(dir7, 'config.json'), 'utf8')).worlds['qq-initiative'];
    check('V15', written.whitelistPrivate === '123456789, 222222222', `config.json whitelistPrivate=${written.whitelistPrivate}`);
    check('V15', written.whitelist === undefined, `派生 whitelist 未落盘（=${written.whitelist}）`);
    check('V15', persisted7.every((p) => p.whitelist === undefined), `persist 载荷不含 whitelist：${JSON.stringify(persisted7)}`);

    // 模拟重启：新实例读回同一份 config.json
    const reloaded = JSON.parse(readFileSync(join(dir7, 'config.json'), 'utf8')).worlds['qq-initiative'];
    const cfg8 = baseConfig({ ...reloaded, outboundHttpUrl: onebot.baseUrl });
    const host8 = createHost(join(root, 'v15-restart'));
    const world8 = new ProactiveWorld(createCtx(join(root, 'v15-restart'), cfg8, []), { tickIntervalMs: 60_000 });
    await world8.start(host8);
    const vars = world8.envPromptVars();
    check('V15', vars.proactiveWhitelist.includes('222222222'), `重启后白名单=${vars.proactiveWhitelist}`);
    await world8.stop();
    await world7.stop();
  }

  // ============================================================ V4 自发搭话
  if (want('V4')) {
    section('V4', '无人对话 60~90 分钟内自发出现 sent（不手动触发）');
    const dir9 = join(root, 'v4');
    const cfg9 = baseConfig({ outboundHttpUrl: onebot.baseUrl, privateMinIntervalMin: 1 });
    const host9 = createHost(dir9);
    const world9 = new ProactiveWorld(createCtx(dir9, cfg9, []), { tickIntervalMs: 80 });
    await world9.start(host9);

    // 一条真实入站消息（10 分钟前），让对方进入"活跃但静默"状态，随后不再有任何手动触发
    host9.append({
      type: 'qq.message',
      ts: new Date(Date.now() - 10 * 60_000).toISOString(),
      source: 'qq',
      origin: 'external',
      text: '我先去忙啦',
      senderKey: 'private:123456789',
      meta: { conv: 'private:123456789', card: '羽羽' },
    });

    // 等自驱 tick 自己把事件投递出来
    let pushed = null;
    for (let i = 0; i < 40 && !pushed; i++) {
      await wait(50);
      pushed = host9.pushed.find((p) => p.type === 'im.proactive.turn') ?? null;
    }
    check('V4', !!pushed, pushed ? `自发触发 ${pushed.type} -> ${pushed.meta.targetAddress}` : '60 秒内没有自发触发');
    if (pushed) {
      // 模拟 Core：投递 → 模型在本轮调用自建发信工具 → 回合结束
      world9.onEventsSettled([pushed], 'delivered');
      await wait(120);
      const send = await toolByName(world9, 'qq_initiative_send').handler(
        { to: pushed.meta.targetAddress, text: '忽然想到你，忙完记得喝水。' },
        {}
      );
      const parsed = parseSendResult(send);
      world9.onTurnEnded();
      const st = readState(dir9);
      check('V4', parsed.ok === true, `自发发信回执 ok=${parsed.ok}`);
      check('V4', st.auditLog.some((a) => a.event === 'sent'), `审计=${st.auditLog.map((a) => a.event).join(',')}`);
      check('V4', st.dailyCount === 1, `dailyCount=${st.dailyCount}`);
    }
    await world9.stop();
  }

  // ============================================================ V5 状态一致性
  if (want('V5')) {
    section('V5', 'proactive_status 的 lastUserMessageTime 与实际对话时间一致');
    // 走真实入站路径：事件库追加一条 qq.message，再由 tick 的游标增量拉取观测
    const talkTs = '2026-11-02T21:40:00+08:00';
    host.append({
      type: 'qq.message',
      ts: talkTs,
      source: 'qq',
      origin: 'external',
      text: '我刚下班，路上有点堵',
      senderKey: 'private:123456789',
      meta: { conv: 'private:123456789', card: '羽羽', role: 'user' },
    });
    await world.tick();
    const statusTool = toolByName(world, 'qq_initiative_status');
    const raw = await statusTool.handler({ address: 'private:123456789' }, {});
    const parsed = JSON.parse(typeof raw === 'string' ? raw : raw.text);
    const t = parsed.session?.lastUserMessageTime ?? 0;
    check('V5', t === Date.parse(talkTs), `lastUserMessageTime=${t} 期望=${Date.parse(talkTs)}`);
    const disk = readState(dir).sessions['private:123456789']?.lastUserMessageTime ?? 0;
    check('V5', disk === t, `落盘一致=${disk}`);
  }

  // ============================================================ V21 nudge 长度
  if (want('V21')) {
    section('V21', '一次主动回合的 nudge 长度 ≤ 400 字符');
    const dirN = join(root, 'v21');
    const cfgN = baseConfig({ outboundHttpUrl: onebot.baseUrl });
    const hostN = createHost(dirN);
    const worldN = new ProactiveWorld(createCtx(dirN, cfgN, []), { tickIntervalMs: 60_000 });
    await worldN.start(hostN);
    await worldN.dispatchProactiveTurn('private:123456789', 'private');
    const pushed = hostN.pushed.at(-1);
    const text = String(pushed?.text ?? '');
    const len = [...text].length;
    check('V21', pushed?.type === 'im.proactive.turn' && len > 0 && len <= 400, `nudge 长度=${len} 字符`);
    check('V21', /to = "private:123456789"/.test(text), 'nudge 内投递地址可直接取用');
    await worldN.stop();
  }

  // ============================================================ V22 ENV_PROMPT 增量
  if (want('V22')) {
    section('V22', 'ENV_PROMPT.md 注入后的前缀增量 ≤ 220 字符');
    const template = readFileSync('src/ENV_PROMPT.md', 'utf8');
    const vars = world.envPromptVars();
    let rendered = template;
    for (const [key, value] of Object.entries(vars)) {
      rendered = rendered.replaceAll(`{{${key}}}`, String(value));
    }
    const len = [...rendered].length;
    check('V22', len <= 220, `注入后长度=${len} 字符（上限 220）`);
    check('V22', !rendered.includes('{{'), '渲染后无残留占位符');
    check('V22', rendered.includes('private:123456789'), '渲染后仍给出白名单');
  }

  // ============================================================ V23 文案不点名其他工具
  if (want('V23')) {
    section('V23', '用户可见文案里不再出现 qq_send');
    const surfaces = [
      ['src/ENV_PROMPT.md', readFileSync('src/ENV_PROMPT.md', 'utf8')],
      ['describe.json', readFileSync('describe.json', 'utf8')],
      ['README.md', readFileSync('README.md', 'utf8')],
    ];
    for (const [name, body] of surfaces) {
      check('V23', !body.includes('qq_send'), `${name} 无 qq_send`);
    }
    // nudge 与面板文案同样不得出现
    const dirC = join(root, 'v23');
    const hostC = createHost(dirC);
    const worldC = new ProactiveWorld(createCtx(dirC, baseConfig({ outboundHttpUrl: onebot.baseUrl }), []), {
      tickIntervalMs: 60_000,
    });
    await worldC.start(hostC);
    await worldC.dispatchProactiveTurn('private:123456789', 'private');
    check('V23', !String(hostC.pushed.at(-1)?.text ?? '').includes('qq_send'), 'nudge 文本无 qq_send');
    const uiSources = ['src/webui/client.ts', 'src/webui/panel.ts'].map((f) => readFileSync(f, 'utf8'));
    const uiHits = uiSources.filter((body) => body.includes('qq_send') && !body.includes('EXTERNAL_SEND_TOOL')).length;
    check('V23', uiHits === 0, `面板源码文案无 qq_send（命中文件数=${uiHits}）`);
    await worldC.stop();
  }

  // ============================================================ V24/V25 连续 3 次主动回合
  if (want('V24') || want('V25')) {
    section('V24/V25', '连续 3 次主动回合：仍只调自建渠道，且 to 与目标一致');
    const dirT = join(root, 'v24');
    const cfgT = baseConfig({ outboundHttpUrl: onebot.baseUrl, privateMinIntervalMin: 1 });
    const hostT = createHost(dirT);
    const worldT = new ProactiveWorld(createCtx(dirT, cfgT, []), { tickIntervalMs: 60_000 });
    await worldT.start(hostT);

    const rounds = [];
    for (let round = 1; round <= 3; round++) {
      // 每轮都换一个白名单目标，确保不是同一条地址蒙对
      const target = `private:12345678${round}`;
      cfgT.whitelistPrivate = `12345678${round}`;
      worldT.stateManager.resetSession(target);
      await worldT.dispatchProactiveTurn(target, 'private', 'idle_chat');
      const pushed = hostT.pushed.at(-1);
      const nudgeText = String(pushed?.text ?? '');

      // 按提示词字面执行：取「调 `工具名`」与 to 的值（模型能读到什么就用什么）
      const toolName = (nudgeText.match(/调 `([^`]+)`/) ?? [])[1] ?? '';
      const toValue = (nudgeText.match(/to = "([^"]+)"/) ?? [])[1] ?? '';
      rounds.push({ round, target, toolName, toValue });

      worldT.onEventsSettled([pushed], 'delivered');
      worldT.onRunPhase({ state: 'model', running: [], enteredAt: new Date().toISOString() });
      const tool = worldT.tools().find((t) => t.name === toolName);
      const raw = tool ? await tool.handler({ to: toValue, text: `第 ${round} 次主动问候` }, {}) : '[send failed] 无此工具';
      const ok = String(typeof raw === 'string' ? raw : raw?.text ?? '').startsWith('成功已发送到');
      rounds[round - 1].sent = ok;
      worldT.onTurnEnded();

      // 每个回合计入最小区间，下一轮前清掉冷却
      worldT.stateManager.updateSession(target, (row) => {
        row.lastProactiveSentTime = 0;
      });
    }

    const st = readState(dirT);
    const mismatches = st.auditLog.filter((a) => a.event === 'target_mismatch').length;
    check('V24', rounds.every((r) => r.toolName === 'qq_initiative_send'), `三轮取的渠道=${rounds.map((r) => r.toolName).join('|')}`);
    check('V24', rounds.every((r) => r.sent === true), `三轮真实发送=${rounds.map((r) => r.sent).join('|')}`);
    check('V24', st.dailyCount === 3, `dailyCount=${st.dailyCount}`);
    check('V25', rounds.every((r) => r.toValue === r.target), `to 与目标：${rounds.map((r) => `${r.toValue}→${r.target}`).join(' | ')}`);
    check('V25', mismatches === 0, `审计里 target_mismatch 条数=${mismatches}`);
    await worldT.stop();
  }

  // ============================================================ 开箱默认值：什么都不做
  {
    section('DEFAULTS', '默认配置不会向任何地址发送消息');
    check('DEFAULTS', PROACTIVE_DEFAULTS.enabled === false, '默认 enabled=false');
    check('DEFAULTS', parseWhitelist(PROACTIVE_DEFAULTS).length === 0, '默认白名单为空');
    check(
      'DEFAULTS',
      PROACTIVE_DEFAULTS.whitelistPrivate === '' && PROACTIVE_DEFAULTS.whitelistGroup === '',
      'whitelistPrivate / whitelistGroup 默认留空'
    );
    check('DEFAULTS', PROACTIVE_DEFAULTS.outboundHttpUrl === '', 'outboundHttpUrl 默认留空（由 sender 兜底）');
    const dirD = join(root, 'defaults');
    const hostD = createHost(dirD);
    const worldD = new ProactiveWorld(createCtx(dirD, { ...PROACTIVE_DEFAULTS }, []), { tickIntervalMs: 60_000 });
    await worldD.start(hostD);
    const guard = worldD.quotaManager.canTrigger('private:123456789', 'private', { ...PROACTIVE_DEFAULTS }, {});
    check('DEFAULTS', guard.allowed === false, `默认配置下任何地址都被拒绝：${guard.reason}`);
    await worldD.stop();
  }

  // ============================================================ 附带：parseTs 与契约自证
  {
    section('MISC', 'parseTs 健壮性与契约自证');
    check('M1', parseTs(1711800000) === 1711800000000, '秒级时间戳换算');
    check('M2', parseTs('2026-03-30T10:00:00.000Z') === Date.parse('2026-03-30T10:00:00.000Z'), 'ISO 字符串');
    check(
      'M3',
      typeof world.tick === 'function' && typeof world.onTurnEnded === 'function',
      '自有调度入口存在（tick 不属于 Core 契约，由定时器调用）'
    );
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(world));
    check('M4', !proto.includes('onEvent'), `不再实现契约外的 onEvent（原型方法：${proto.filter((p) => p.startsWith('on')).join(',')}）`);
  }

  // ============================================================ V26~V29 派发冷却
  if (want('V26') || want('V27') || want('V28') || want('V29')) {
    section('V26', '派发后按配置写回下次派发时间');
    const dirC = join(root, 'cooldown');
    const cfgC = baseConfig({ outboundHttpUrl: onebot.baseUrl, privateMinIntervalMin: 7, privateMaxIntervalMin: 7 });
    const hostC = createHost(dirC);
    const worldC = new ProactiveWorld(createCtx(dirC, cfgC, []), { tickIntervalMs: 60_000 });
    await worldC.start(hostC);

    const addrC = 'private:123456789';
    const dispatched = await worldC.dispatchProactiveTurn(addrC, 'private', 'idle_chat', '羽羽');
    const sessC = worldC.stateManager.getSession(addrC);
    const waitMin = sessC?.nextScheduledTime ? (sessC.nextScheduledTime - Date.now()) / 60_000 : 0;
    check('V26',
      dispatched && !!sessC?.nextScheduledTime && waitMin > 6 && waitMin <= 7.2,
      `派发后写回 nextScheduledTime，${waitMin.toFixed(1)} 分钟后才允许再派发（配置 7 分钟）`);

    section('V27', '冷却期内不再选中该会话');
    // 造一个"活跃但静默"的会话，再手动把它推进冷却
    worldC.stateManager.updateSession(addrC, (s) => {
      s.lastUserMessageTime = Date.now() - 20 * 60_000;
      s.unrepliedCount = 0;
      s.nextScheduledTime = Date.now() + 10 * 60_000;
    });
    const bestC = worldC.scheduler.pickBestCandidate(cfgC, {}, Date.now());
    check('V27',
      !bestC || bestC.session.address !== addrC,
      `冷却中的会话未被选中（选中的是 ${bestC ? bestC.session.address : '无'}）`);

    section('V28', '模型选择安静时同样写回冷却');
    // 走完整路径：清掉上一轮在途质押与冷却 → 派发 → 模型确实看到了这轮 → 回合结束但没发出
    worldC.quotaManager.rollbackPledge('test_cleanup');
    worldC.stateManager.updateSession(addrC, (s) => { s.nextScheduledTime = 0; });
    await worldC.dispatchProactiveTurn(addrC, 'private', 'idle_chat', '羽羽');
    worldC.onRunPhase({ state: 'model' });
    worldC.onTurnEnded();
    const sessC2 = worldC.stateManager.getSession(addrC);
    const waitMin2 = sessC2?.nextScheduledTime ? (sessC2.nextScheduledTime - Date.now()) / 60_000 : 0;
    check('V28',
      !!sessC2?.nextScheduledTime && waitMin2 > 6,
      `静默回滚后仍写回冷却，${waitMin2.toFixed(1)} 分钟内不会重派`);

    section('V29', '区间配置时落在配置区间内');
    const dirR = join(root, 'cooldown-range');
    const cfgR = baseConfig({ outboundHttpUrl: onebot.baseUrl, privateMinIntervalMin: 5, privateMaxIntervalMin: 30 });
    const hostR = createHost(dirR);
    const worldR = new ProactiveWorld(createCtx(dirR, cfgR, []), { tickIntervalMs: 60_000 });
    await worldR.start(hostR);
    const waits = [];
    for (let i = 0; i < 12; i++) {
      worldR.quotaManager.rollbackPledge('test_cleanup');
      const a = 'private:123456789';
      await worldR.dispatchProactiveTurn(a, 'private', 'idle_chat', '羽羽');
      const s = worldR.stateManager.getSession(a);
      waits.push(s?.nextScheduledTime ? (s.nextScheduledTime - Date.now()) / 60_000 : -1);
      // 清掉冷却，好让下一次派发不被拦（这里只想量间隔本身）
      worldR.stateManager.updateSession(a, (x) => { x.nextScheduledTime = 0; });
    }
    const inRange = waits.every((w) => w >= 4.9 && w <= 30.2);
    const varied = new Set(waits.map((w) => Math.round(w))).size > 1;
    check('V29',
      inRange && varied,
      `12 次间隔全部落在 5~30 分钟内（最小 ${Math.min(...waits).toFixed(1)}，最大 ${Math.max(...waits).toFixed(1)}），且不完全相同`);
  }
} finally {
  await onebot.close();
  rmSync(root, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    for (const f of failed) console.log(`FAIL ${f.id} ${f.current}: ${f.detail}`);
  }
}
