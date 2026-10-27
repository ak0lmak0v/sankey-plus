// Keep transient percentage labels available while the reader selects text or
// moves to a comment toolbar outside the SVG. Never consume native selection
// events: the host page needs them to offer its own comment action.
export function linkLabelSelection(svg, layer, hold, cancel) {
  let active = false;
  const document = svg.ownerDocument;
  const contains = (parent, child) => !!child && parent.contains(child);
  const enter = () => cancel();
  const begin = () => {
    active = true;
    cancel();
    hold();
  };
  layer.addEventListener('mouseover', enter);
  layer.addEventListener('pointerdown', begin);
  return {
    active: () => active,
    hold: begin,
    release: () => { active = false; },
    keepOnClick(event) {
      if (contains(layer, event.target)) return true;
      // A host's comment button / editor lives outside the chart. Clicking it
      // must not hide or rewrite the quoted text before the comment is saved.
      if (active && !contains(svg, event.target)) return true;
      const selection = document.defaultView?.getSelection?.();
      if (selection && !selection.isCollapsed && selection.rangeCount) {
        for (let i = 0; i < selection.rangeCount; i++) {
          if (selection.getRangeAt(i).intersectsNode(layer)) return true;
        }
      }
      return false;
    },
    dispose() {
      layer.removeEventListener('mouseover', enter);
      layer.removeEventListener('pointerdown', begin);
      active = false;
    }
  };
}

// Select the real text, so host annotation tools receive a native Range rather
// than a synthetic comment event or a platform-specific API call.
export function selectCommentText(element) {
  if (!element || !element.textContent?.trim()) return false;
  const doc = element.ownerDocument;
  const selection = doc.defaultView?.getSelection?.();
  if (!selection) return false;
  const range = doc.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
