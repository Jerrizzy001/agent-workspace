/** Shared behavior for every modal, including portals and nested dialogs. */
export function installModalAccessibility() {
  let current: HTMLElement | undefined;
  const returnFocus = new WeakMap<HTMLElement, HTMLElement>();
  let inert: [HTMLElement, boolean][] = [];
  const visible = (el: HTMLElement) => !!el.getClientRects().length;
  const controls = (el: HTMLElement) =>
    [
      ...el.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
      ),
    ].filter(visible);
  const focus = (dialog: HTMLElement) => {
    const fields = controls(dialog);
    const initial =
      fields.find((el) => el.matches("input,textarea,select")) || fields[0];
    dialog.tabIndex = -1;
    (initial || dialog).focus();
  };
  const restoreInert = () => {
    for (const [el, was] of inert) el.inert = was;
    inert = [];
  };
  const update = () => {
    const next = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="dialog"][aria-modal="true"]',
      ),
    ]
      .filter(visible)
      .at(-1);
    if (next === current) return;
    const old = current;
    restoreInert();
    current = next;
    if (old && !old.isConnected) returnFocus.get(old)?.focus();
    if (!next) return;
    if (!returnFocus.has(next) && document.activeElement instanceof HTMLElement)
      returnFocus.set(next, document.activeElement);
    // Inert only siblings of the path to the active dialog, never an ancestor.
    for (
      let node: HTMLElement = next;
      node.parentElement;
      node = node.parentElement
    ) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && sibling instanceof HTMLElement) {
          inert.push([sibling, sibling.inert]);
          sibling.inert = true;
        }
      }
      if (node.parentElement === document.body) break;
    }
    if (!next.contains(document.activeElement)) focus(next);
  };
  const key = (event: KeyboardEvent) => {
    if (!current) return;
    if (event.key === "Escape") {
      const close = controls(current).find(
        (el) =>
          el.matches("button") &&
          (/^close\b/i.test(el.getAttribute("aria-label") || "") ||
            /^(cancel|close|done)$/i.test(el.textContent?.trim() || "")),
      );
      if (close) {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.click();
      }
      // The command palette has its own Escape handler and no close button.
      // Let that handler run instead of swallowing Escape.
    } else if (event.key === "Tab") {
      const items = controls(current);
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (!items.length) {
        event.preventDefault();
        current.focus();
      } else if (
        event.shiftKey ? index <= 0 : index === -1 || index === items.length - 1
      ) {
        event.preventDefault();
        items[event.shiftKey ? items.length - 1 : 0]!.focus();
      }
    }
  };
  const keepFocus = (event: FocusEvent) => {
    if (current?.isConnected && !current.contains(event.target as Node))
      focus(current);
  };
  const observer = new MutationObserver(update);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("keydown", key, true);
  document.addEventListener("focusin", keepFocus, true);
  return () => {
    observer.disconnect();
    restoreInert();
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("focusin", keepFocus, true);
  };
}
