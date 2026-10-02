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
