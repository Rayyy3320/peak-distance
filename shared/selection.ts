// getRangeAt may re-scope a native drag selection to the Shadow DOM host.
export function shadowSelection(root:ShadowRoot):{text:string;range:Range}|null {
  const selection=getSelection();
  // isCollapsed can be true for the re-scoped host even while shadow text is selected.
  if(!selection||!selection.rangeCount)return null;
  const selected=selection.getComposedRanges?.({shadowRoots:[root]})[0]??selection.getRangeAt(0);
  if(!root.contains(selected.startContainer)||!root.contains(selected.endContainer))return null;
  const range=document.createRange();
  range.setStart(selected.startContainer,selected.startOffset);
  range.setEnd(selected.endContainer,selected.endOffset);
  const text=range.toString().trim();
  return text?{text,range}:null;
}

/**
 * Range 在容器元素拼接文本中的偏移（正文块/字幕行 → 原文定位用）。
 * 端点不在容器的文本节点内（元素边界等）返回 null，调用方不猜。
 */
export function rangeOffsetsIn(root:Element,range:Range):{start:number;end:number;text:string}|null {
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  let acc=0,start=-1,end=-1;
  for(let n=walker.nextNode();n;n=walker.nextNode()){
    const node=n as Text;
    if(node===range.startContainer)start=acc+Math.min(range.startOffset,node.length);
    if(node===range.endContainer)end=acc+Math.min(range.endOffset,node.length);
    acc+=node.length;
  }
  if(start<0||end<0)return null;
  return {start,end,text:root.textContent??''};
}

/** 把 Range 收窄到元素内部（跨出元素的部分不取：字幕译文/控件文字）。 */
export function clampRangeToElement(range:Range,el:Element):Range {
  const out=range.cloneRange();
  if(!el.contains(out.startContainer))out.setStart(el,0);
  if(!el.contains(out.endContainer))out.setEnd(el,el.childNodes.length);
  return out;
}

// 选区文本块的通用检测：内联标签（样式与结构上的行内元素）。
const INLINE_TAGS=new Set(['A','SPAN','B','I','EM','STRONG','CODE','S','U','MARK','SMALL','SUB','SUP','ABBR','TIME','CITE','Q','WBR','BDI','BDO','DATA','DFN','KBD','SAMP','VAR','RUBY','RT','RP','LABEL','FONT','BIG','NOBR','INS','DEL']);

/**
 * 节点所在的最小文本块（段落级容器）：向上穿过连续的内联祖先，停在第一个
 * 非内联元素。语义页得到 p/li 本身；div 结构站（X 推文 tweetText、YouTube
 * 描述/评论的 yt-formatted-string）得到该文本容器本身。不依赖固定语义标签
 * 清单——清单在 div 站点取不到块，选区会被一律当作跨块句段，单词分类、
 * 有效表达补全与卡片清洗整体失效（选区查词在 X 上的实际根因）。
 */
export function inlineRunContainer(node:Node|null):HTMLElement|null {
  const el=node instanceof Element?node:node?.parentElement??null;
  if(!el)return null;
  let block:HTMLElement=el as HTMLElement;
  while(INLINE_TAGS.has(block.tagName)&&block.parentElement)block=block.parentElement;
  return block;
}
