// NativeDelete by Moumen Soliman, user-supplied source: docs/references/native-delete.tsx.txt.
// DOM adaptation; provenance and license availability: docs/REFERENCES.md.
import './deleteButton.css';

const paths = {
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
};
const icon = (kind: keyof typeof paths) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg>`;

// Critically damped spring: bounce=0, duration=.35, zero initial velocity.
// Solve (1+x)e^-x=.001, then sample its physical response for native WAAPI.
let frequency = 5 / .35;
for (let i = 1; i < 12; i++) {
  const decay = Math.exp(-frequency * .35);
  frequency -= (decay * (frequency * .35 + 1) - .001) / (-decay * frequency * .35 ** 2);
}
const spring = Array.from({ length: 71 }, (_, i) => {
  const t = i / 70 * .35;
  return i === 70 ? 1 : 1 - (1 + frequency * t) * Math.exp(-frequency * t);
});

export function createDeleteButton(args: { buttonText?: string; onDelete(): void }) {
  const element = document.createElement('div'); element.className = 'native-delete';
  element.style.setProperty('--native-delete-spring', `linear(${spring.join(',')})`);
  const main = document.createElement('button'); main.type = 'button'; main.className = 'native-delete-main';
  const graphic = document.createElement('span'); graphic.className = 'native-delete-icon'; graphic.innerHTML = icon('trash');
  const text = document.createElement('span'); text.textContent = args.buttonText ?? 'Delete';
  main.append(graphic, text); main.setAttribute('aria-label', text.textContent);
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'native-delete-cancel';
  cancel.setAttribute('aria-label', 'Cancel delete'); cancel.innerHTML = icon('x'); cancel.hidden = true;
  element.append(main, cancel);
  let expanded = false, version = 0;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function animateState(next: boolean) {
    expanded = next;
    const current = ++version;
    const label = next ? 'Confirm' : args.buttonText ?? 'Delete';
    main.setAttribute('aria-label', label);
    const oldWidth = main.getBoundingClientRect().width;
    const oldLayoutWidth = element.getBoundingClientRect().width;
    const measure = main.cloneNode(true) as HTMLButtonElement;
    measure.style.cssText = 'position:absolute;visibility:hidden;width:auto';
    measure.lastElementChild!.textContent = label; element.append(measure);
    const newWidth = measure.getBoundingClientRect().width; measure.remove();
    for (const animation of main.getAnimations()) animation.cancel();
    if (!reduced()) main.animate(spring.map(p => ({ width: `${oldWidth + (newWidth - oldWidth) * p}px` })), { duration: 350 });
    main.style.width = `${newWidth}px`;
    cancel.hidden = false;
    for (const animation of cancel.getAnimations()) animation.cancel();
    const frames = spring.map(p => {
      const value = next ? p : 1 - p;
      return { opacity: value, transform: `translateX(${(value - 1) * 8}px) scale(${.8 + value * .2})` };
    });
    // popLayout: exiting cancel stops occupying layout immediately.
    cancel.classList.toggle('exiting', !next);
    const newLayoutWidth = newWidth + (next ? 48 : 0);
    for (const animation of element.getAnimations()) animation.cancel();
    if (!reduced()) element.animate(spring.map(p => ({ width: `${oldLayoutWidth + (newLayoutWidth - oldLayoutWidth) * p}px` })), { duration: 350 });
    element.style.width = `${newLayoutWidth}px`;
    if (reduced()) cancel.hidden = !next;
    else void cancel.animate(frames, { duration: 350 }).finished.then(() => { if (version === current) cancel.hidden = !next; }).catch(() => {});
    const swap = () => { graphic.innerHTML = icon(next ? 'check' : 'trash'); text.textContent = label; };
    if (reduced()) { swap(); return; }
    const out = [graphic.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.8)' }], { duration: 150, easing: 'ease-in-out' }),
      text.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 150, easing: 'ease-in-out' })];
    void Promise.all(out.map(a => a.finished)).then(() => {
      if (version !== current) return;
      swap();
      graphic.animate([{ opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 150, easing: 'ease-in-out' });
      text.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 150, easing: 'ease-in-out' });
    }).catch(() => {});
  }
  main.addEventListener('click', () => {
    if (main.disabled) return;
    if (!expanded) animateState(true);
    else { animateState(false); args.onDelete(); }
  });
  cancel.addEventListener('click', () => animateState(false));
  return { element, setDisabled(disabled: boolean) { main.disabled = disabled; } };
}
