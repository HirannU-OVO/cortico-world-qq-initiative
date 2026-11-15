/**
 * 隔离安装验收（Issue #1 硬项）。
 *
 * 目的：证明本扩展在"只装了它自己、没有任何兄弟扩展"的市场布局下，
 * 既能加载、也能真的把一条文字发出去；配图逻辑已整体移出本包。
 *
 * 做四件事（全部真执行，无占位）：
 *   1. npm pack 到临时目录；
 *   2. 另一个空目录 npm i 这个 tgz（不装任何别的包）；
 *   3. 逐个 import 安装包里的 src/**\/*.ts（跳过 .d.ts 与浏览器入口 client.ts）；
 *   4. 起本地 stub OneBot HTTP，用安装包里的 OutboundSender 以 builtin 通道实发一条纯文本，
 *      校验回执与请求体：消息是纯字符串、没有图片段、标记原样。
 *
 * 退出码：0 = 全部 PASS；1 = 有 FAIL。
 * 用法：node verify/isolated-install.mjs   （Node < 22.6 需加 --experimental-strip-types）
 */
import { execFileSync, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_NAME = 'cortico-world-qq-initiative';
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${detail}` : ''}`);
}

/** 该 Node 是否原生支持剥离 TS 类型（22.6+ 需开关，23+ 默认）。 */
const tsReady = process.features?.typescript !== false;
if (!tsReady && !process.execArgv.includes('--experimental-strip-types')) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', ...process.argv.slice(1)], {
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

/** npm 的 JS 入口：优先用 npm 注入的 npm_execpath，其次用 Node 自带 npm。 */
function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((p) => p && existsSync(p)) ?? '';
}
const npmCli = resolveNpmCli();

function npmRun(args, cwd) {
  // 直接用 node 执行 npm-cli.js：不经过 shell（无 DEP0190），也不会命中系统里的 npm.ps1/shim。
  if (npmCli) {
    return execFileSync(process.execPath, [npmCli, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240_000,
    });
  }
  // 兜底：没有 npm-cli.js 时退回 shell 命令（单条字符串，不传 args）。
  const quoted = args
    .map((a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a)))
    .join(' ');
  return execSync(`npm ${quoted}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240_000,
  });
}

/** 递归列出目录下所有文件（返回相对 root 的 posix 路径）。 */
function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(relative(root, abs).split(sep).join('/'));
    }
  }
  return out.sort();
}

function startStubOneBot() {
  const state = { calls: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = {};
      }
      state.calls.push({ url: req.url, payload, raw: body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 10001 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'qqinitiative-iso-'));
let stub = null;

try {
  // 1) pack
  let tgz;
  try {
    npmRun(['pack', '--pack-destination', tmp], pkgRoot);
    tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  } catch (err) {
    check('pack', false, String(err?.stderr || err?.message || err).slice(0, 400));
  }
  if (!tgz) {
    if (!results.some((r) => r.name === 'pack')) check('pack', false, '未产出 tgz');
  } else {
    check('pack', true, tgz);
  }

  // 2) 空目录安装
  const work = join(tmp, 'work');
  let installed = '';
  if (tgz) {
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'iso-check', private: true, type: 'module' }, null, 2));
    try {
      npmRun(['i', join(tmp, tgz), '--no-audit', '--no-fund', '--ignore-scripts'], work);
      const inModules = join(work, 'node_modules', PKG_NAME);
      check('install', existsSync(inModules), inModules);
      // Node 拒绝对 node_modules 里的 .ts 做类型剥离（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
      // 复制到安装目录外再加载；安装本身仍是真的走了 npm i。
      installed = join(work, 'pkg');
      if (existsSync(inModules)) cpSync(inModules, installed, { recursive: true });
    } catch (err) {
      check('install', false, String(err?.stderr || err?.message || err).slice(0, 400));
    }
  } else {
    check('install', false, '跳过：没有 tgz');
  }

  // 3) 文件清单与逐个 import
  let srcFiles = [];
  if (installed && existsSync(installed)) {
    srcFiles = walk(join(installed, 'src'));
    const stickerFiles = srcFiles.filter((f) => /(^|\/)sticker-[^/]*\.ts$/.test(f));
    check('files', srcFiles.length > 0 && stickerFiles.length === 0,
      `src 文件 ${srcFiles.length} 个；残留配图文件 ${stickerFiles.length ? stickerFiles.join(', ') : '无'}`);

    const importErrs = [];
    const skipped = [];
    for (const rel of srcFiles.filter((f) => f.endsWith('.ts'))) {
      // .d.ts 没有运行时；webui/client.ts 是浏览器构建入口（import ./style.css），Node 不可加载。
      if (rel.endsWith('.d.ts') || rel === 'webui/client.ts') {
        skipped.push(rel);
        continue;
      }
      try {
        await import(pathToFileURL(join(installed, 'src', rel)).href);
      } catch (err) {
        importErrs.push(`${rel}: ${err?.code || err?.name || 'Error'} ${String(err?.message || '').slice(0, 120)}`);
      }
    }
    check('imports', importErrs.length === 0,
      importErrs.length ? importErrs.slice(0, 3).join(' | ') : `已加载 ${srcFiles.length - skipped.length} 个模块（跳过 ${skipped.join(', ')}）`);
  } else {
    check('files', false, '跳过：未安装');
    check('imports', false, '跳过：未安装');
  }

  // 4) stub OneBot + 实发
  if (installed && existsSync(installed)) {
    stub = await startStubOneBot();
    const base = `http://127.0.0.1:${stub.port}`;
    const { PROACTIVE_DEFAULTS } = await import(pathToFileURL(join(installed, 'src/config.ts')).href);
    const { OutboundSender } = await import(pathToFileURL(join(installed, 'src/outbound/sender.ts')).href);

    const logs = [];
    const sender = new OutboundSender({
      getConfig: () => ({
        ...PROACTIVE_DEFAULTS,
        outboundMode: 'builtin',
        outboundHttpUrl: base,
        outboundHttpToken: '',
      }),
      log: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
    });

    const plain = '在吗，吃上饭没';
    const r1 = await sender.send('private:10001', plain);
    const call1 = stub.state.calls[0] ?? {};
    const raw1 = call1.raw ?? '';
    check('send(builtin)', sender.mode === 'builtin' && r1.ok === true && call1.payload?.message === plain,
      `通道=${sender.mode}｜ok=${r1.ok}｜err=${r1.error ?? '无'}｜message=${JSON.stringify(call1.payload?.message)}`);
    check('send-text-only', !raw1.includes('"type":"image"') && !raw1.includes('"type","image"'),
      raw1.includes('image') ? '请求体出现图片段' : '请求体无图片段');

    // 标记原样：本包不解析、不剥离、不变段
    stub.state.calls.length = 0;
    logs.length = 0;
    const marker = '[表情包:开心/x.gif]';
    const r2 = await sender.send('group:20002', marker);
    const call2 = stub.state.calls[0] ?? {};
    check('marker-verbatim', r2.ok === true && call2.payload?.message === marker,
      `ok=${r2.ok} message=${JSON.stringify(call2.payload?.message)}`);

    const crossPkg = logs.filter((l) => /sticker|跨包|cortico-world-qq-stickers|表情/i.test(l));
    check('no-cross-package', crossPkg.length === 0,
      crossPkg.length ? crossPkg.slice(0, 2).join(' | ') : '日志无跨包/表情相关记录');
  } else {
    for (const n of ['send(builtin)', 'send-text-only', 'marker-verbatim', 'no-cross-package']) {
      check(n, false, '跳过：未安装');
    }
  }
} finally {
  if (stub) stub.server.close();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== 隔离安装摘要 =====`);
console.log(`检查项 ${results.length} 个，通过 ${results.length - failed.length} 个，失败 ${failed.length} 个`);
if (failed.length) {
  console.log(`失败项：${failed.map((f) => f.name).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('结论：空目录可安装、模块可加载、纯文本可发送、无配图逻辑。');
}
