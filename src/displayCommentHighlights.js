// Read only the host's painted annotation ranges through the standard CSS
// Custom Highlight API. These names belong to Display's current renderer;
// unsupported hosts/browsers simply retain ordinary chart interactions.
const names = [
  'display-comment-anchor', 'display-comment-anchor-resolved',
  'display-comment-anchor-hover-open', 'display-comment-anchor-hover-resolved',
  'display-comment-anchor-focused-open', 'display-comment-anchor-focused-resolved'
];
const same = (a, b) => a.size === b.size && [...a].every(item => b.has(item));

export function displayCommentHighlights(svg, onChange) {
  const view = svg.ownerDocument.defaultView;
  svg.setAttribute('data-comment-highlights', view?.CSS?.highlights ? 'available' : 'unavailable');
  let annotated = new Set(), focused = null, disposed = false, timer;
  const anchorFor = range => {
    if (range.collapsed) return null;
    const anchorAt = node => {
      const element = node.nodeType === 1 ? node : node.parentElement;
      const anchor = element?.closest?.('.sankey-comment-anchor');
      return anchor && svg.contains(anchor) ? anchor : null;
    };
    const start = anchorAt(range.startContainer), end = anchorAt(range.endContainer);
    // Ignore ranges outside this chart or spanning multiple chart elements.
    return start && start === end ? start : null;
  };
  const refresh = () => {
    if (disposed) return;
    const next = new Set();
    let nextFocus = null;
    const registry = view?.CSS?.highlights;
    for (const name of names) {
      const highlight = registry?.get(name);
      if (!highlight) continue;
      for (const range of highlight) {
        const anchor = anchorFor(range);
        if (!anchor) continue;
        next.add(anchor);
        if (name.includes('-focused-')) nextFocus = anchor;
      }
    }
    if (!same(annotated, next) || focused !== nextFocus) {
      const focusChanged = focused !== nextFocus;
      annotated = next;
      focused = nextFocus;
      onChange({annotated, focused, focusChanged});
    }
  };
  const dispose = () => { disposed = true; view?.clearInterval(timer); };
  if (view?.CSS?.highlights) {
    refresh();
    // The native registry has no change event. Sample at a low frequency and
    // repaint only on a changed set; no layout reads or API monkey-patching.
    timer = view.setInterval(() => {
      if (!svg.isConnected) return dispose();
      if (svg.ownerDocument.visibilityState !== 'hidden') refresh();
    }, 250);
  }
  return {refresh, dispose};
}

// Only dismiss selections owned by this diagram. A reader may be selecting
// unrelated report text while the host focuses an existing comment.
export function clearChartSelection(svg) {
  const selection = svg.ownerDocument.defaultView?.getSelection?.();
  if (!selection) return;
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (svg.contains(range.startContainer) && svg.contains(range.endContainer)) {
      selection.removeAllRanges();
      return;
    }
  }
}
