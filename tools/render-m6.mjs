// 在现有 render-check 浏览器中检查 MAIN/ISOLATED 双轨与取消链路。
export async function renderM6({ browser, port, content, inject, installStub, check }) {
  // 真实双入口；只替换网络和播放器轨道表，复现首轨抢选与令牌刷新时序。
  const loading = await browser.newPage();
  await loading.goto(`http://127.0.0.1:${port}/watch?v=loading01`);
  await loading.evaluate(installStub);
  await loading.evaluate(() => {
    window.__requests = [];
    window.__messages = [];
    window.__sourceAborted = 0;
    window.addEventListener('message', e => {
      if (e.data?.source === 'blc-inject') window.__messages.push(e.data);
    });
    window.ytInitialPlayerResponse = {
      videoDetails: { videoId: 'loading01' },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { languageCode: 'ar', kind: 'asr' }, { languageCode: 'en', kind: 'asr' },
      ] } },
    };
    window.fetch = async (input, init = {}) => {
      const u = new URL(input);
      window.__requests.push(u.toString());
      if (window.__failSource) return new Response('');
      if (window.__requireFresh && u.searchParams.get('pot') !== 'renewed') return new Response('');
      if (u.searchParams.get('lang') !== 'en') return new Response('');
      if (!u.searchParams.has('pot')) {
        // 旧无令牌请求卡住，新令牌请求必须能立即接管。
        return new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => { window.__sourceAborted++; reject(new DOMException('abort', 'AbortError')); }, { once: true });
        });
      }
      return Response.json({ events: [{ tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'Current English captions.' }] }] });
    };
    document.querySelector('video').currentTime = 1;
  });
  await loading.addScriptTag({ content: inject });
  await loading.addScriptTag({ content });
  await loading.waitForFunction(() => document.getElementById('blc-debug')?.getAttribute('data-blc-log')?.includes('tracklist'));
  await loading.evaluate(() => { void fetch('https://www.youtube.com/api/timedtext?v=loading01&lang=en&kind=asr&fmt=json3').catch(() => {}); });
  await loading.waitForFunction(() => window.__requests.length >= 2);
  await loading.evaluate(() => { void fetch('https://www.youtube.com/api/timedtext?v=loading01&lang=en&kind=asr&fmt=json3&pot=fresh'); });
  const recovered = await loading.waitForFunction(() => document.getElementById('blc-debug')?.getAttribute('data-blc-count') === '1', null, { timeout: 4000 }).then(() => true, () => false);
  check('字幕首轨不是当前语言时不抢选；有效令牌立即接管旧请求', recovered, JSON.stringify(await loading.evaluate(() => ({ requests: window.__requests.map(s => { const u = new URL(s); return `${u.searchParams.get('lang')}:${u.searchParams.has('pot')}`; }), notice: document.getElementById('blc-subs')?.shadowRoot?.querySelector('.notice')?.textContent }))));
  check('新来源取消旧请求', await loading.evaluate(() => window.__sourceAborted === 1));

  await loading.evaluate(() => {
    window.__failSource = true;
    history.pushState({}, '', '/watch?v=loading02');
    window.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await loading.waitForFunction(() => document.getElementById('blc-debug')?.getAttribute('data-blc-video') === 'loading02');
  await loading.evaluate(() => { void fetch('https://www.youtube.com/api/timedtext?v=loading02&lang=en&kind=asr&pot=valid'); });
  await loading.getByRole('button', { name: '重试字幕', exact: true }).waitFor();
  check('空响应结束 loading 并保留原生字幕', await loading.evaluate(() => !document.getElementById('blc-hide-native-captions') && document.getElementById('blc-debug').getAttribute('data-blc-count') === ''));
  await loading.evaluate(() => {
    window.__failSource = false;
    window.__requireFresh = true;
    document.querySelector('.ytp-subtitles-button').addEventListener('click', e => {
      if (e.currentTarget.getAttribute('aria-pressed') === 'true') void fetch('https://www.youtube.com/api/timedtext?v=loading02&lang=en&kind=asr&pot=renewed');
    });
  });
  await loading.getByRole('button', { name: '重试字幕', exact: true }).click();
  await loading.waitForFunction(() => document.getElementById('blc-debug')?.getAttribute('data-blc-count') === '1');
  check('点击重试使播放器刷新失效来源并恢复当前视频字幕', await loading.getByRole('button', { name: '重试字幕', exact: true }).count() === 0);
  await loading.close();

  const silent = await browser.newPage();
  await silent.goto(`http://127.0.0.1:${port}/watch?v=silent01`);
  await silent.clock.install();
  await silent.evaluate(installStub);
  await silent.addScriptTag({ content }); // MAIN 未注入/无响应
  await silent.clock.runFor(31000);
  check('MAIN 无响应也在整体截止时间结束等待并可重试', await silent.getByRole('button', { name: '重试字幕', exact: true }).isVisible());
  await silent.close();

  for (const kind of ['manual', 'asr', 'missing']) {
    const page = await browser.newPage({ viewport: { width: 720, height: 420 } });
    await page.goto(`http://127.0.0.1:${port}/watch?v=m6test01`);
    await page.evaluate(installStub);
    await page.evaluate(kind => {
      const originalSend = browser.runtime.sendMessage;
      window.__requests = []; window.__generic = []; window.__aborted = 0; window.__controls = [];
      browser.runtime.sendMessage = (m, cb) => {
        if (['subtitleMode', 'setSetting', 'openSettings'].includes(m.type)) window.__controls.push(m);
        if (m.type === 'translateCues' && window.__genericFail) return cb({ ok: false, error: 'network' });
        if (m.type === 'captionCache') return cb({ ok: true });
        if (m.type === 'translateCues') window.__generic.push(m);
        return originalSend(m, cb);
      };
      const raw = kind === 'asr'
        ? [[0, 2000, 'the'], [800, 2200, 'the plane']]
        : [[0, 2000, 'first'], [2000, 2000, 'second']];
      const json = rows => ({ events: rows.map(([tStartMs, dDurationMs, text]) => ({ tStartMs, dDurationMs, segs: [{ utf8: text }] })) });
      const tracks = [{ languageCode: 'en', kind: kind === 'asr' ? 'asr' : '', baseUrl: 'https://www.youtube.com/api/timedtext?v=m6test01&lang=en' }];
      if (kind !== 'asr') tracks.push({ languageCode: 'zh-Hans', baseUrl: 'https://www.youtube.com/api/timedtext?v=m6test01&lang=zh-Hans' });
      window.ytInitialPlayerResponse = { videoDetails: { videoId: 'm6test01' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } };
      window.fetch = async (input, init = {}) => {
        const u = new URL(input); window.__requests.push(u.toString());
        const translated = u.searchParams.get('tlang') || u.searchParams.get('lang').startsWith('zh');
        if (translated && window.__hold) {
          window.__held = true;
          return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { window.__aborted++; reject(new DOMException('abort', 'AbortError')); }, { once: true }));
        }
        if (u.searchParams.get('lang').startsWith('zh')) return Response.json(json(kind === 'missing' ? [] : [[2000, 2000, '第二句']]));
        if (u.searchParams.has('tlang')) return Response.json(json(kind === 'missing' ? [] : kind === 'asr' ? [[0, 2000, '这'], [800, 2200, '这架飞机']] : [[0, 2000, '第一句'], [2000, 2000, '平台第二句']]));
        return Response.json(json(raw));
      };
      document.querySelector('video').currentTime = 1;
      window.__source = `https://www.youtube.com/api/timedtext?v=m6test01&lang=en${kind === 'asr' ? '&kind=asr' : ''}&pot=test`;
    }, kind);
    await page.addScriptTag({ content: inject });
    await page.addScriptTag({ content });
    await page.evaluate(() => fetch(window.__source));
    await page.waitForFunction(() => document.getElementById('blc-subs')?.shadowRoot?.querySelector('.zh')?.textContent);
    let state = await page.evaluate(() => ({ text: document.getElementById('blc-subs').shadowRoot.querySelector('.zh').textContent, generic: window.__generic.length, count: document.getElementById('blc-debug').getAttribute('data-blc-count') }));
    if (kind === 'manual') {
      check('平台仅补独立中文轨道缺失句', state.text === '第一句' && state.generic === 0);
      await page.evaluate(() => { document.querySelector('video').currentTime = 2.5; });
      await page.waitForFunction(() => document.getElementById('blc-subs')?.shadowRoot?.querySelector('.zh')?.textContent === '第二句');
      check('独立中文轨道成功句不被平台译文覆盖', true);
    } else if (kind === 'asr') check('真实双入口协议在 ASR 合并时保留配对译文', state.count === '1' && state.text === '这架飞机' && state.generic === 0);
    else check('平台路径缺失后才调用常规翻译，ID 不移位', state.text === '译0' && state.generic === 1);
    const before = await page.evaluate(() => window.__requests.length + window.__generic.length);
    await page.evaluate(() => document.getElementById('blc-subs-switch').shadowRoot.querySelector('#bilingual').click());
    await page.locator('#blc-subs-switch #learning').click();
    check(`${kind} 关闭双语后学习菜单仍能访问翻译方式与设置`, await page.getByRole('combobox', { name: '本视频翻译方式' }).isVisible() && await page.getByRole('button', { name: '打开设置', exact: true }).isVisible());
    await page.evaluate(() => document.getElementById('blc-subs-switch').shadowRoot.querySelector('#bilingual').click());
    await page.waitForFunction(() => document.getElementById('blc-subs')?.shadowRoot?.querySelector('.zh'));
    check(`${kind} 显示开关复用成功结果`, before === await page.evaluate(() => window.__requests.length + window.__generic.length));
    if (kind === 'manual') {
      // 改轨后留下一个可取消的中文请求，隐藏中文必须 abort 且保留英文。
      await page.evaluate(() => { window.__hold = true; void fetch(window.__source + '&name=new'); });
      await page.waitForFunction(() => window.__held === true);
      // M11 起加载文案按目标语言显示（默认中文）
      await page.waitForFunction(() =>
        (document.getElementById('blc-subs')?.shadowRoot?.querySelector('.notice')?.textContent ?? '').startsWith('正在获取') &&
        (document.getElementById('blc-subs')?.shadowRoot?.querySelector('.notice')?.textContent ?? '').endsWith('译文…'),
      );
      check('等待中文时显示明确加载状态', true);
      await page.locator('#blc-subs-switch #chinese').uncheck();
      await page.waitForFunction(() => window.__aborted > 0);
      check('隐藏中文中止 MAIN 在途请求，英文仍显示', await page.locator('#blc-subs .en').count() === 1);
    }
    if (kind === 'missing') {
      await page.getByRole('combobox', { name: '本视频翻译方式' }).selectOption('ai');
      await page.waitForFunction(() => window.__controls.some(m => m.type === 'subtitleMode' && m.mode === 'ai'));
      check('翻译方式选择器设置本视频 AI 且不改全局默认', await page.evaluate(() => !window.__controls.some(m => m.type === 'setSetting' && m.name === 'translationMode')));
      await page.locator('#blc-subs .zh').filter({hasText:/译/}).waitFor();
      const beforeSwitch = await page.evaluate(()=>window.__generic.length);
      await page.evaluate(()=>window.__broadcast({type:'ai-service-changed'}));
      await page.waitForFunction(n=>window.__generic.length>n,beforeSwitch);
      check('切换 AI 服务清理当前视频译文并重新请求',true);
      await page.getByRole('button', { name: '打开设置', exact: true }).click();
      check('播放器设置入口发送打开设置动作', await page.evaluate(() => window.__controls.some(m => m.type === 'openSettings')));
      await page.locator('#blc-subs-switch #learning').click();
      await page.evaluate(() => { window.__genericFail = true; });
      await page.getByRole('combobox', { name: '本视频翻译方式' }).selectOption('regular');
      await page.getByText('翻译暂不可用', { exact: true }).waitFor();
      check('中文失败显示恢复动作并保留英文', await page.getByRole('button', { name: '用 AI 翻译', exact: true }).isVisible() && await page.locator('#blc-subs .en').isVisible());
    }
    await page.close();
  }
}
