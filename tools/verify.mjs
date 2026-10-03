// M0 验收脚本：真实 Chrome 加载扩展，在真实视频上验证字幕链路。
//
// 做什么：
//   1. 用独立 user-data-dir 启动真实 Chrome（不影响用户正在运行的会话），
//      以 --load-extension 加载 .output/chrome-mv3，开放 CDP 端口；
//   2. 打开人工字幕视频 → 等待徽标 data-blc-state="cues"，
//      记录 cue 数、轨道类型、带时间戳的原文；
//   3. 打开仅平台自动字幕(asr)的视频 → 同样验证；
//   4. 站内点击相关视频（SPA 导航）→ 验证旧状态被清理、新字幕属于新视频。
//
// 用法：node tools/verify.mjs [--manual <url>] [--asr <url>...]

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const PROFILE = path.join(ROOT, '.chrome-profile');
const PORT = 9333;

const MANUAL_URL = 'https://www.youtube.com/watch?v=arj7oStGLkU'; // TED: Inside the mind of a master procrastinator
const ASR_URLS = [
  'https://www.youtube.com/watch?v=_OBlgSz8sSM', // Charlie bit my finger
  'https://www.youtube.com/watch?v=txqiwrbYGrs', // David After Dentist
  'https://www.youtube.com/watch?v=jNQXAC9IVRw', // Me at the zoo
  'https://www.youtube.com/watch?v=9bZkp7q19f0', // GANGNAM STYLE
];

// Chrome 137+ 要求开启开发者模式才允许加载 unpacked 扩展。
// 在独立 profile 的 Preferences 里预置该偏好（Chrome 首次启动时合并）。
function seedDeveloperMode() {
  const prefDir = path.join(PROFILE, 'Default');
  const prefFile = path.join(prefDir, 'Preferences');
  let prefs = {};
  try {
    prefs = JSON.parse(readFileSync(prefFile, 'utf8'));
  } catch {
    /* 首次运行尚不存在 */
  }
  prefs.extensions = prefs.extensions || {};
  prefs.extensions.ui = prefs.extensions.ui || {};
  prefs.extensions.ui.developer_mode = true;
  mkdirSync(prefDir, { recursive: true });
  writeFileSync(prefFile, JSON.stringify(prefs));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { manual: MANUAL_URL, asr: ASR_URLS };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--manual') out.manual = args[++i];
    else if (args[i] === '--asr') out.asr = [args[++i], ...out.asr];
  }
  return out;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error('未找到 Chrome，可通过 CHROME_PATH 环境变量指定 chrome.exe 路径');
}

function probeDirect() {
  return new Promise((resolve) => {
    const req = https.get('https://www.youtube.com/generate_204', { timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 204);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// 本机常见本地代理端口（Clash 7890、v2rayN 10809 等）。探测通过
// 代理能否到达 YouTube；直连不可达时给 Chrome 传 --proxy-server。
function probeProxy(port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: 'https://www.youtube.com/generate_204',
        headers: { Host: 'www.youtube.com' },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 204);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function detectProxy() {
  if (process.env.BLC_PROXY) {
    console.log(`使用 BLC_PROXY 指定的代理: ${process.env.BLC_PROXY}`);
    return process.env.BLC_PROXY;
  }
  if (await probeDirect()) {
    console.log('网络：可直连 YouTube');
    return null;
  }
  const ports = [7890, 7897, 2080, 10809, 1080, 8888];
  for (const p of ports) {
    if (await probeProxy(p)) {
      console.log(`网络：直连不可达，检测到本地代理 127.0.0.1:${p} 可通 YouTube`);
      return `http://127.0.0.1:${p}`;
    }
  }
  throw new Error(
    '直连与常见本地代理（7890/7897/2080/10809/1080/8888）都无法访问 YouTube。' +
      '请开启代理后重试，或用 BLC_PROXY=http://127.0.0.1:端口 指定。',
  );
}

function endpointReady(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await endpointReady(port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`CDP 端口 http://127.0.0.1:${port} 未就绪`);
}

async function readBadge(page) {
  return page.evaluate(() => {
    const el = document.getElementById('blc-debug');
    if (!el) return null;
    const g = (n) => el.getAttribute(n) ?? '';
    return {
      state: g('data-blc-state'),
      video: g('data-blc-video'),
      track: g('data-blc-track'),
      trackLang: g('data-blc-track-lang'),
      count: g('data-blc-count'),
      navSeq: g('data-blc-nav-seq'),
      log: g('data-blc-log'),
    };
  });
}

// 等待徽标满足条件；期间处理广告跳过与播放恢复。
async function waitBadge(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await readBadge(page);
    } catch {
      return null; // 页面/浏览器已关闭
    }
    if (last && predicate(last)) return last;
    // 广告出现时字幕不会来：尝试跳过
    const skip = page.locator('.ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    if ((await skip.count().catch(() => 0)) > 0) {
      await skip.first().click().catch(() => {});
    }
    // 自动播放被策略拦下时手动恢复
    await page
      .evaluate(() => {
        const p = document.getElementById('movie_player');
        if (p && typeof p.playVideo === 'function') p.playVideo();
      })
      .catch(() => {});
    await page.waitForTimeout(1500).catch(() => {});
  }
  return last;
}

// YouTube 同意页（部分地区）：接受后重进。
async function handleConsent(page) {
  const url = page.url();
  if (!url.includes('consent.')) return;
  for (const name of ['Accept all', '全部接受', 'Alle akzeptieren', 'Tout accepter']) {
    const btn = page.getByRole('button', { name, exact: false });
    if ((await btn.count()) > 0) {
      await btn.first().click().catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(2000);
  await page.goBack().catch(() => {});
}

async function captionTracksEvidence(page) {
  return page.evaluate(() => {
    const pick = (pr) => {
      const r = pr?.captions?.playerCaptionsTracklistRenderer;
      return Array.isArray(r?.captionTracks) ? r.captionTracks : [];
    };
    let tracks = pick(window.ytInitialPlayerResponse);
    if (!tracks.length) {
      try {
        const p = document.getElementById('movie_player');
        if (p && typeof p.getPlayerResponse === 'function') {
          tracks = pick(p.getPlayerResponse());
        }
      } catch {
        /* ignore */
      }
    }
    const pr = window.ytInitialPlayerResponse;
    return {
      title: pr?.videoDetails?.title || document.title || '',
      author: pr?.videoDetails?.author || '',
      tracks: tracks.map((t) => ({
        lang: t.languageCode || '',
        kind: t.kind || 'manual',
      })),
    };
  });
}

// 打开视频页；被 YouTube 强制重定向到 Google 登录页时回退并重试。
async function gotoVideo(page, url, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);
      const cur = page.url();
      if (cur.includes('accounts.google.com')) {
        console.log(`  [${label}] 被重定向到 Google 登录页，回退后重试 (${attempt + 1}/3)`);
        await page
          .goto('https://www.youtube.com', {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          })
          .catch(() => {});
        await page.waitForTimeout(2500);
        continue;
      }
      return true;
    } catch {
      // 导航被后续重定向打断 —— 检查落点再决定
      const cur = page.url();
      if (cur.includes('accounts.google.com')) {
        console.log(`  [${label}] 导航被打断且落点为登录页，重试 (${attempt + 1}/3)`);
        await page.waitForTimeout(2500);
        continue;
      }
      await page.waitForTimeout(2000);
    }
  }
  console.log(`  [${label}] 多次重试后仍未稳定打开 ${url}，落点: ${page.url()}`);
  return false;
}

let shotSeq = 0;
async function debugShot(page, tag) {
  shotSeq++;
  const file = path.join(PROFILE, `verify-debug-${shotSeq}-${tag}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  console.log(`  📸 调试截图: ${file}`);
}

function cueEvidence(badge) {
  if (!badge?.log) return [];
  try {
    return JSON.parse(badge.log)
      .filter((e) => e.type === 'cues')
      .slice(-3)
      .map((e) => ({ videoId: e.videoId, track: e.track, count: e.count, first: e.first }));
  } catch {
    return [];
  }
}

function fmt(ok) {
  return ok ? '✅' : '❌';
}

async function main() {
  const args = parseArgs();
  if (!existsSync(EXT_DIR)) {
    throw new Error(`未找到 ${EXT_DIR}，请先运行 npm run build`);
  }
  const chromePath = findChrome();
  const proxy = await detectProxy();
  seedDeveloperMode();
  console.log(`Chrome: ${chromePath}`);
  console.log(`扩展目录: ${EXT_DIR}`);

  const chrome = spawn(
    chromePath,
    [
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      ...(proxy ? [`--proxy-server=${proxy}`] : []),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chrome.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s && !/^$/m.test(s)) console.log(`    [chrome] ${s.slice(0, 200)}`);
  });

  const results = [];
  let page;
  let browser;
  try {
    await waitForEndpoint(PORT, 20000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const ctx = browser.contexts()[0];
    // 复用初始标签页，避免启动流程关掉新建页
    for (let i = 0; i < 20 && ctx.pages().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 300));
    }
    page = ctx.pages()[0] ?? (await ctx.newPage());
    page.on('close', () => console.log('  ⚠ 页面被关闭'));
    page.on('crash', () => console.log('  ⚠ 页面崩溃'));
    // SOCS cookie：跳过部分地区同意页，也缓解匿名流量的登录重定向
    await ctx
      .addCookies([{ name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/' }])
      .catch(() => {});
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[blc]')) console.log(`    [console] ${t.slice(0, 180)}`);
    });

    // 扩展加载诊断：MV3 background 是 service worker
    const sws = ctx.serviceWorkers();
    console.log(
      `扩展 service worker: ${sws.length ? sws.map((s) => s.url()).join(', ') : '（未发现 —— 扩展未加载！）'}`,
    );

    // ---------- 1) 人工字幕 ----------
    console.log(`\n=== 测试 1：人工字幕 ${args.manual} ===`);
    await gotoVideo(page, args.manual, 'manual');
    await handleConsent(page);
    const manualBadge = await waitBadge(page, (b) => b.state === 'cues', 60000);
    const manualEvidence = await captionTracksEvidence(page).catch(() => null);
    console.log(
      `  页面: ${manualEvidence?.title || '?'} — ${manualEvidence?.author || '?'}`,
    );
    console.log(
      `  平台轨道列表: ${JSON.stringify(manualEvidence?.tracks ?? [])}`,
    );
    if (manualBadge) {
      console.log(
        `  取得: video=${manualBadge.video} track=${manualBadge.trackLang}(${manualBadge.track}) cues=${manualBadge.count}`,
      );
      for (const c of cueEvidence(manualBadge)) console.log(`    ${c.first}`);
    }
    const manualOk =
      !!manualBadge &&
      manualBadge.state === 'cues' &&
      manualBadge.track === 'manual' &&
      Number(manualBadge.count) > 0;
    results.push(['人工字幕取得带时间原文', manualOk]);
    if (!manualOk) {
      console.log('  ❌ 未取得人工字幕（见上方控制台与状态）');
      await debugShot(page, 'manual');
    }

    // ---------- 2) 平台自动字幕 (asr) ----------
    console.log(`\n=== 测试 2：平台自动字幕(asr) ===`);
    let asrBadge = null;
    let asrEvidence = null;
    let asrUrlUsed = '';
    for (const url of args.asr) {
      console.log(`  尝试 ${url}`);
      if (!(await gotoVideo(page, url, 'asr'))) continue;
      await handleConsent(page);
      const b = await waitBadge(page, (x) => x.state === 'cues' || x.state === 'nocues', 60000);
      asrEvidence = await captionTracksEvidence(page).catch(() => null);
      if (b?.state === 'cues') {
        asrBadge = b;
        asrUrlUsed = url;
        console.log(`  页面: ${asrEvidence?.title || '?'}`);
        console.log(`  平台轨道列表: ${JSON.stringify(asrEvidence?.tracks ?? [])}`);
        console.log(
          `  取得: video=${b.video} track=${b.trackLang}(${b.track}) cues=${b.count}`,
        );
        for (const c of cueEvidence(b)) console.log(`    ${c.first}`);
        if (b.track === 'asr') break; // 拿到 asr 轨道即成
      } else {
        console.log(`  该视频未产出字幕（state=${b?.state ?? 'none'}），换下一个`);
      }
    }
    const asrOk =
      !!asrBadge &&
      asrBadge.state === 'cues' &&
      asrBadge.track === 'asr' &&
      Number(asrBadge.count) > 0;
    results.push(['平台自动字幕(asr)取得带时间原文', asrOk]);
    if (!asrOk) {
      console.log('  ❌ 未在候选视频上取得 asr 字幕');
      await debugShot(page, 'asr');
    }

    // ---------- 3) 站内切换（SPA 导航）----------
    console.log(`\n=== 测试 3：站内切换视频后旧状态清理 ===`);
    // 从人工字幕视频出发，点击相关视频（SPA，无整页刷新）
    await gotoVideo(page, args.manual, 'spa');
    const before = await waitBadge(page, (b) => b.state === 'cues', 60000);
    if (!before) {
      results.push(['站内切换后状态属于新视频', false]);
      console.log('  ❌ 起始视频未就绪，无法测试切换');
    } else {
      let after = null;
      for (let i = 0; i < 5 && !after; i++) {
        // 每轮重新定位：SPA 导航后相关视频列表 DOM 会整体替换
        const rel = page.locator('#related a#thumbnail[href*="watch?v="]');
        const n = await rel.count();
        if (n === 0) {
          console.log('  未找到相关视频链接');
          break;
        }
        await rel.nth(i % n).click({ timeout: 5000 }).catch(() => {});
        // 等待徽标切换到新视频并产出 cues
        after = await waitBadge(
          page,
          (b) => b.video && b.video !== before.video && b.state === 'cues',
          30000,
        );
        if (!after) {
          const cur = await readBadge(page);
          if (!cur || cur.video === before.video) {
            console.log(`  相关视频 #${i} 点击未生效，换下一个`);
          } else {
            console.log(`  相关视频 ${cur.video} 无字幕（state=${cur.state}），换下一个`);
          }
        }
      }
      if (after) {
        const urlVid = new URL(page.url()).searchParams.get('v') || '';
        const log = (() => {
          try {
            return JSON.parse(after.log);
          } catch {
            return [];
          }
        })();
        const clearEvents = log.filter((e) => e.type === 'clear');
        const clearIdx = log.findIndex(
          (e) => e.type === 'clear' && e.from === before.video,
        );
        const cuesAfterClear = log.slice(clearIdx).filter((e) => e.type === 'cues');
        const oldResidue = cuesAfterClear.some((e) => e.videoId === before.video);
        console.log(`  旧视频: ${before.video}（cues=${before.count}）`);
        console.log(`  新视频: ${after.video}（cues=${after.count}, track=${after.trackLang}(${after.track})）`);
        console.log(`  导航清理事件: ${JSON.stringify(clearEvents)}`);
        for (const c of cueEvidence(after).slice(-1)) console.log(`    新视频首条: ${c.first}`);
        const switchOk =
          after.video !== before.video &&
          after.video === urlVid &&
          clearIdx >= 0 &&
          !oldResidue &&
          Number(after.count) > 0;
        results.push(['站内切换后状态属于新视频、无旧字幕残留', switchOk]);
        if (!switchOk) console.log('  ❌ 切换校验未通过');
      } else {
        results.push(['站内切换后状态属于新视频', false]);
        console.log('  ❌ 点击相关视频后未在新视频上取得字幕');
        await debugShot(page, 'spa');
      }
    }

    // ---------- 汇总 ----------
    console.log('\n=== 汇总 ===');
    let allOk = true;
    for (const [name, ok] of results) {
      console.log(`${fmt(ok)} ${name}`);
      if (!ok) allOk = false;
    }
    process.exitCode = allOk ? 0 : 1;
  } finally {
    await browser?.close().catch(() => {});
    // Windows 上需要杀掉整棵进程树
    spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
