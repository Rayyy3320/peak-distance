// 页面外壳只负责定位，设置与工作区运行在扩展源 iframe 内。
import type { PanelFrameState } from './panel';
export function initFloatingPanel() {
  const hostId=crypto.randomUUID();
  let host: HTMLElement | null = null;
  let normalOpen = false;
  let x: number | null = null, y = 24;
  let frameReady=false;
  let frameLoaded=false;
  let frameEpoch=0, probeSequence=0;
  let readyExpired=false;
  let readyTimer:ReturnType<typeof setTimeout>|undefined;
  let readyCallbacks: Array<(ok:boolean)=>void>=[];
  let observedSubs:Element|null=null;
  const subtitlesResize=new ResizeObserver(()=>place());
  // 通知类上报：扩展重载后残留宿主的页面事件仍会触发，此时
  // runtime.sendMessage 同步抛 Extension context invalidated（.catch 挂不上），
  // 按无处可上报处理
  const notify = (msg: Record<string, unknown>) => {
    try { void browser.runtime.sendMessage(msg).catch(() => {}); } catch { /* ignore */ }
  };
  const hide = () => { if(host) host.hidden = true; document.dispatchEvent(new Event('pd-panel-layout')); };
  const status = (text: string, failed = false) => {
    const root = host?.shadowRoot;
    if (!root) return;
    root.querySelector<HTMLElement>('.status')!.hidden = !text;
    root.querySelector<HTMLElement>('.status-text')!.textContent = text;
    root.querySelector<HTMLButtonElement>('.retry')!.hidden = !failed;
  };
  const finishReady = (ok: boolean) => { for (const done of [...readyCallbacks]) done(ok); };
  const expectReady = () => {
    clearTimeout(readyTimer);frameReady=false;readyExpired=false;status('正在准备工作区…');
    readyTimer=setTimeout(()=>{readyExpired=true;status('工作区未能就绪，请重试',true);finishReady(false);console.warn('[pd] floating workspace ready timeout',{epoch:frameEpoch});},8000);
  };
  async function probe(stage: 'load' | 'show' | 'probe'): Promise<boolean> {
    const epoch=frameEpoch, request=++probeSequence;
    try {
      const state = await browser.runtime.sendMessage({type:'panelFrameStatus',stage}) as PanelFrameState | undefined;
      if(epoch!==frameEpoch || request!==probeSequence)return frameReady;
      frameReady=!!state?.ok;
      if(frameReady){clearTimeout(readyTimer);readyExpired=false;status('');finishReady(true);}
      else if(!readyExpired&&(!frameLoaded || state?.phase==='loading'))status('正在准备工作区…');
      else {status('工作区暂不可用，请重试',true);finishReady(false);}
      return frameReady;
    } catch {
      if(epoch===frameEpoch&&request===probeSequence){frameReady=false;status('无法连接扩展，请重试；仍失败时刷新当前网页',true);finishReady(false);}
      console.warn('[pd] floating workspace transport failed', {stage,reason:'runtime-message-failed'});
      return false;
    }
  }
  const place = () => {
    if (!host) return;
    const parent = document.fullscreenElement ?? document.documentElement;
    const subs=document.getElementById('blc-subs');
    if(subs!==observedSubs){subtitlesResize.disconnect();if(subs)subtitlesResize.observe(subs);observedSubs=subs;}
    // 全屏内为字幕安全区避让；非全屏可在整个视口内移动（不钳在播放器上方）
    const reserved=document.fullscreenElement?Math.max(160,(document.getElementById('blc-subs')?.offsetHeight??80)+88):12;
    const safeBottom=document.fullscreenElement?innerHeight-reserved:innerHeight-12;
    host.style.maxHeight=`${Math.max(180,safeBottom-12)}px`;
    if (host.parentElement !== parent) {
      const movable = parent as Element & {moveBefore?:(node:Node,child:Node|null)=>void};
      if(host.isConnected && movable.moveBefore) movable.moveBefore(host,null); else parent.append(host);
    }
    host.style.left = `${Math.max(12, Math.min(x ?? innerWidth - 412, innerWidth - host.offsetWidth - 12))}px`;
    host.style.top = `${Math.max(12,Math.min(y,safeBottom-host.offsetHeight))}px`;
    document.dispatchEvent(new Event('pd-panel-layout'));
  };
  const show = async (view?:string) => {
    if(!host) {
      host = document.createElement('aside'); host.id = 'pd-floating-panel';
      host.style.cssText = 'position:fixed;width:min(400px,calc(100vw - 24px));height:min(720px,calc(100dvh - 32px));z-index:2147483645;';
      const root = host.attachShadow({mode:'open'});
      root.innerHTML = `<style>:host{color-scheme:light}[hidden]{display:none!important}.shell{height:100%;display:flex;flex-direction:column;overflow:hidden;border:1px solid #ddd9cf;border-radius:12px;background:#f7f4ec;box-shadow:0 12px 40px #0003}.drag{border:0;background:#e9e6df;color:#59636b;height:16px;flex:none;cursor:move;touch-action:none;font:12px/12px system-ui}.drag:focus-visible,.retry:focus-visible{outline:2px solid #1a5fc4;outline-offset:-2px}.status{display:flex;align-items:center;gap:12px;flex:none;padding:12px;color:#59636b;font:13px/1.6 system-ui}.status-text{flex:1}.retry{font:inherit;cursor:pointer;padding:6px 10px;color:#1a5fc4;background:#fffdfa;border:1px solid #ddd9cf;border-radius:6px}iframe{border:0;width:100%;flex:1;min-height:0;background:#f7f4ec}</style><div class="shell"><button class="drag" aria-label="拖动面板，方向键移动">⋯</button><div class="status" role="status" hidden><span class="status-text"></span><button class="retry" hidden>重试</button></div><iframe title="Peak Distance 学习面板" allow="clipboard-write"></iframe></div>`;
      const frame = root.querySelector('iframe')!;
      frame.addEventListener('load',()=>{frameEpoch++;frameLoaded=true;expectReady();void probe('load');});
      frame.addEventListener('error',()=>{clearTimeout(readyTimer);frameReady=false;readyExpired=true;status('工作区加载失败，请重试',true);finishReady(false);console.warn('[pd] floating workspace iframe load failed');});
      root.querySelector<HTMLButtonElement>('.retry')!.addEventListener('click',async()=>{
        const retry=root.querySelector<HTMLButtonElement>('.retry')!;retry.disabled=true;
        try {
          const result=await browser.runtime.sendMessage({type:'panelFrameRetry'});
          if(!result?.ok)throw Error('retry-unavailable');
          frameEpoch++;frameLoaded=false;expectReady();
          frame.src=browser.runtime.getURL('/sidepanel.html')+'?floating=1';
        } catch {status('无法恢复工作区，请刷新当前网页后重试',true);}
        finally {retry.disabled=false;}
      });
      frame.src = browser.runtime.getURL('/sidepanel.html') + '?floating=1';
      expectReady();
      const drag = root.querySelector<HTMLElement>('.drag')!;
      drag.addEventListener('pointerdown', e => {
        const bounds = host!.getBoundingClientRect(), sx=e.clientX, sy=e.clientY;
        drag.setPointerCapture(e.pointerId);
        const move = (ev:PointerEvent) => {x=bounds.left+ev.clientX-sx;y=bounds.top+ev.clientY-sy;place();};
        const stop = () => {drag.removeEventListener('pointermove',move);drag.removeEventListener('pointerup',stop);};
        drag.addEventListener('pointermove',move);drag.addEventListener('pointerup',stop);
      });
      drag.addEventListener('keydown', e => {if(e.key.startsWith('Arrow')) {e.preventDefault(); const r=host!.getBoundingClientRect();x=r.left+(e.key==='ArrowRight'?16:e.key==='ArrowLeft'?-16:0);y=r.top+(e.key==='ArrowDown'?16:e.key==='ArrowUp'?-16:0);place();}});
      host.addEventListener('keydown', e=>{e.stopPropagation();if(e.key==='Escape')notify({type:'panelClose'});});
    }
    host.hidden = false; place();
    if(await probe('show'))return {ok:true,hostId};
    if(readyExpired)return {ok:false,hostId};
    const ok=await new Promise<boolean>(resolve=>{const done=(ok:boolean)=>{readyCallbacks=readyCallbacks.filter(cb=>cb!==done);resolve(ok);};readyCallbacks.push(done);});
    return {ok,hostId};
  };
  browser.runtime.onMessage.addListener((m:unknown,sender,reply)=>{
    if(sender.id !== browser.runtime.id) return;
    const msg=m as {type?:string;view?:string;at?:number};
    if(msg.type==='pd-popup-outside'){document.dispatchEvent(new CustomEvent('pd-popup-outside',{detail:{at:msg.at}}));return;}
    if(msg.type==='pd-panel-ready'){void probe('probe').then(ok=>reply({ok}));return true;}
    if(msg.type==='pd-panel-status') {reply({ok:true,fullscreen:!!document.fullscreenElement,open:!!host&&!host.hidden});return;}
    if(msg.type==='pd-panel-hide') {hide();reply({ok:true});return;}
    if(msg.type==='pd-panel-show') {void show(msg.view).then(reply);return true;}
  });
  document.addEventListener('fullscreenchange',()=>{
    notify({type:'panelFullscreen',fullscreen:!!document.fullscreenElement});
    if(document.fullscreenElement) {normalOpen=!!host&&!host.hidden;hide();place();}
    else {place();if(normalOpen&&host)host.hidden=false;else hide();document.dispatchEvent(new Event('pd-panel-layout'));}
  });
  window.addEventListener('resize',place);
  const healthTimer=setInterval(()=>{if(host&&!host.hidden&&document.visibilityState==='visible')void probe('probe');},10000);
  document.addEventListener('pointerdown', () => { notify({ type:'panelOutsideClick', at:performance.timeOrigin+performance.now() }); }, true);
  window.addEventListener('pagehide',()=>{notify({type:'panelHostClosed',hostId});clearInterval(healthTimer);clearTimeout(readyTimer);subtitlesResize.disconnect();host?.remove();});
  return {show,hide,isOpen:()=>!!host&&!host.hidden};
}
