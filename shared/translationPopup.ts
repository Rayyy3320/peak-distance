import { brandTokens, brandControls } from './brand';
import { selectionError, type SelectionSnapshot } from './panel';

export function createTranslationPopup(send: <T>(msg: unknown) => Promise<T>) {
  let host: HTMLElement | null = null;
  let requestId = '';
  let focus: HTMLElement | null = null;
  let sourcePage='';
  const navigationTimer=setInterval(()=>{if(host&&location.href!==sourcePage)close();},250);
  function close() {
    if (requestId) void send({ type: 'cancelOnline', requestId });
    requestId = ''; host?.remove(); host = null; focus?.focus();
  }
  function open(snapshot: SelectionSnapshot, rect?: DOMRect | null) {
    close(); focus = document.activeElement as HTMLElement;
    sourcePage=location.href;
    host = document.createElement('div'); host.id = 'pd-translation';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${brandTokens}:host{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:var(--pd-ink)}*{box-sizing:border-box}${brandControls}
      .card{pointer-events:auto;position:fixed;width:min(420px,calc(100vw - 24px));max-height:calc(100dvh - 32px);display:flex;flex-direction:column;background:var(--pd-paper);border:1px solid var(--pd-line);border-radius:12px;box-shadow:var(--pd-shadow)}
      header,footer{display:flex;gap:8px;align-items:center;padding:12px 16px}header{border-bottom:1px solid var(--pd-line)}header strong{flex:1}main{overflow:auto;padding:0 16px;min-height:0}p{white-space:pre-wrap;overflow-wrap:anywhere}small,a{color:var(--pd-muted)}footer{border-top:1px solid var(--pd-line)}#result{font-size:15px}#close{margin-left:auto}
    </style><section class="card" role="dialog" aria-label="选区翻译"><header><strong>翻译</strong><button id="close" aria-label="关闭翻译">×</button></header><main><p id="original"></p><small>简体中文 · Google 翻译</small><p id="result" role="status">正在翻译…</p><a id="source" target="_blank" rel="noopener"></a></main><footer><button id="copy" disabled>复制译文</button><button id="retry">重试</button></footer></section>`;
    root.querySelector('#original')!.textContent = snapshot.text;
    const link = root.querySelector<HTMLAnchorElement>('#source')!;
    if (/^https?:\/\//.test(snapshot.url)) link.href = snapshot.url;
    link.textContent = snapshot.title || '原文来源';
    (document.fullscreenElement ?? document.documentElement).append(host);
    const card = root.querySelector<HTMLElement>('.card')!;
    const width = card.getBoundingClientRect().width;
    card.style.left = `${Math.max(12, Math.min(rect?.left ?? innerWidth - width - 24, innerWidth - width - 12))}px`;
    card.style.top = `${Math.max(16, Math.min((rect?.bottom ?? 64) + 8, innerHeight - Math.min(card.scrollHeight, innerHeight - 32) - 16))}px`;
    const result = root.querySelector<HTMLElement>('#result')!;
    const copy = root.querySelector<HTMLButtonElement>('#copy')!;
    const retry = root.querySelector<HTMLButtonElement>('#retry')!;
    let translated = '';
    const run = async () => {
      if (requestId) void send({ type:'cancelOnline', requestId });
      const error = selectionError(snapshot.text);
      if (error) { result.textContent = error; retry.hidden = true; return; }
      const id = requestId = `selection-${crypto.randomUUID()}`;
      copy.disabled = true; copy.textContent='复制译文'; retry.disabled = true; result.textContent = '正在翻译…';
      const r = await send<{ok:boolean; text?:string; error?:string}>({ type:'translateSelection', text:snapshot.text, requestId:id });
      if (requestId !== id || !host) return;
      if(location.href!==sourcePage){close();return;}
      retry.disabled = false;
      translated = r?.ok ? r.text ?? '' : '';
      result.textContent = translated || (r?.error==='restricted'?'翻译服务限制访问，请稍后重试。原文已保留。':r?.error==='network'?'网络连接失败，请检查连接后重试。原文已保留。':'翻译暂不可用，请重试。原文已保留。'); copy.disabled = !translated;
    };
    root.querySelector('#close')!.addEventListener('click', close);
    retry.addEventListener('click', () => void run());
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(translated); copy.textContent = '已复制'; } catch { copy.textContent = '复制失败，请重试'; } });
    host.addEventListener('keydown', e => { e.stopPropagation(); if(e.key === 'Escape') { e.preventDefault(); close(); } });
    host.addEventListener('mousedown', e => e.stopPropagation());
    root.querySelector<HTMLButtonElement>('#close')!.focus({preventScroll:true});
    void send({type:'selectionSnapshot', snapshot});
    void run();
  }
  window.addEventListener('pagehide', () => {close();clearInterval(navigationTimer);});
  return { open, close };
}
