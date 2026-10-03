// 在现有 render-check 浏览器中检查 MAIN/ISOLATED 双轨与取消链路。
export async function renderM6({ browser, port, content, inject, installStub, check }) {
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
      await page.getByText('正在获取中文字幕…', { exact: true }).waitFor();
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
