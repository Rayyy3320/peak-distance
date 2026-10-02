import tokens from './tokens.css?inline';
export const brandTokens = tokens;
export const brandControls = `
  button,select,input,textarea { font:inherit; box-sizing:border-box; }
  button,select { cursor:pointer; } button { border:1px solid var(--pd-line); border-radius:6px; background:var(--pd-surface); color:var(--pd-ink); padding:6px 10px; }
  button:hover { background:var(--pd-selected); } button:disabled { cursor:wait; opacity:.6; }
  button:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible { outline:2px solid var(--pd-blue); outline-offset:2px; }
`;
