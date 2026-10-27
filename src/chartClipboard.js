// Copy only from a reader's click. Never use a temporary textarea or replace
// the native Selection: host comment tools depend on those live text ranges.
export function copyChartText(svg, text) {
  const doc = svg.ownerDocument;
  const legacyCopy = () => {
    if (typeof doc.execCommand !== 'function') return false;
    const onCopy = event => {
      if (!event.clipboardData) return;
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    };
    doc.addEventListener('copy', onCopy, true);
    try { return !!doc.execCommand('copy'); }
    catch { return false; }
    finally { doc.removeEventListener('copy', onCopy, true); }
  };
  const clipboard = doc.defaultView?.navigator?.clipboard;
  try {
    if (typeof clipboard?.writeText === 'function')
      return Promise.resolve(clipboard.writeText(text)).then(() => true, legacyCopy);
  } catch { /* Fall back without changing focus, DOM or the comment quote. */ }
  return Promise.resolve(legacyCopy());
}

export function chartElementText(data, isLink = false) {
  const name = node => typeof node === 'string' ? node : String(node?.name ?? node?.index ?? '');
  return isLink ? `${name(data?.source)} → ${name(data?.target)}` : name(data);
}
