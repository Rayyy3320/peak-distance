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
