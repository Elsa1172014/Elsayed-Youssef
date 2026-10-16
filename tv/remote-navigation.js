/* Smart Receiver TV: D-pad navigation for TV browser runtimes.
   Import from a TV-specific entrypoint; do not enable on desktop/mobile. */
export function installTvRemoteNavigation(root = document) {
  const selector = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';
  function candidates() {
    return [...root.querySelectorAll(selector)].filter(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
  }
  function move(direction) {
    const items = candidates();
    if (!items.length) return;
    const active = root.activeElement;
    const current = items.includes(active) ? active : null;
    if (!current) { items[0].focus(); return; }
    const a = current.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    const next = items.filter(el => el !== current).map(el => {
      const b = el.getBoundingClientRect(), dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
      const forward = direction === 'left' ? dx < -4 : direction === 'right' ? dx > 4 : direction === 'up' ? dy < -4 : dy > 4;
      const main = direction === 'left' || direction === 'right' ? Math.abs(dx) : Math.abs(dy);
      const cross = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
      return { el, score: main + cross * 2, forward };
    }).filter(x => x.forward).sort((x,y) => x.score-y.score)[0];
    if (next) { next.el.focus(); next.el.scrollIntoView({block:'nearest',inline:'nearest'}); }
  }
  const handler = e => {
    const editable = e.target?.matches?.('input,textarea,[contenteditable="true"]');
    if (editable && !['Escape','Backspace'].includes(e.key)) return;
    const keys = {ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down'};
    if (keys[e.key]) { e.preventDefault(); move(keys[e.key]); }
    else if (e.key === 'Escape' || e.key === 'BrowserBack') {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      else history.back();
    }
  };
  root.addEventListener('keydown',handler);
  requestAnimationFrame(() => candidates()[0]?.focus());
  return () => root.removeEventListener('keydown',handler);
}
