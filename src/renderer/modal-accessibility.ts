const tabbableSelector =
  'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]';
const visible = (el: HTMLElement) => !!el.getClientRects().length;
/** Controls that Tab reaches, in document order. */
const tabbable = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>(tabbableSelector)].filter(
    (el) => el.tabIndex >= 0 && !el.closest("[inert]") && visible(el),
  );
const inTerminal = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest(".xterm");

/**
 * Moves focus to the next control outside `from`, wrapping, and staying inside
 * the open dialog if there is one. Widgets that keep Tab for themselves, such
 * as the terminal, use this so keyboard users can still leave them.
 */
export function focusOutside(from: HTMLElement, backwards: boolean) {
  const scope =
    from.closest<HTMLElement>('[role="dialog"][aria-modal="true"]') ||
    document.body;
  const items = tabbable(scope).filter((el) => !from.contains(el));
  const after = items.filter(
    (el) => from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const before = items.filter(
    (el) => from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING,
  );
  (backwards ? before.at(-1) || items.at(-1) : after[0] || items[0])?.focus();
}

/** Shared behavior for every modal, including portals and nested dialogs. */
export function installModalAccessibility() {
  let current: HTMLElement | undefined;
  const returnFocus = new WeakMap<HTMLElement, HTMLElement>();
  let inert: [HTMLElement, boolean][] = [];
  const focus = (dialog: HTMLElement) => {
    const fields = tabbable(dialog);
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
  // Escape runs after the focused control's own handlers, so a terminal, an
  // inline rename field or a menu that claims Escape (preventDefault) keeps it.
  const escape = (event: KeyboardEvent) => {
    if (
      !current ||
      event.key !== "Escape" ||
      event.defaultPrevented ||
      inTerminal(event.target)
    )
      return;
    const close = tabbable(current).find(
      (el) =>
        el.matches("button") &&
        (/^close\b/i.test(el.getAttribute("aria-label") || "") ||
          /^(cancel|close|done)$/i.test(el.textContent?.trim() || "")),
    );
    // The command palette has its own Escape handler and no close button.
    if (!close) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close.click();
  };
  const tab = (event: KeyboardEvent) => {
    // The terminal keeps Tab for the shell; F6 moves focus out of it.
    if (!current || event.key !== "Tab" || inTerminal(event.target)) return;
    const items = tabbable(current);
    if (!items.length) {
      event.preventDefault();
      current.focus();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    let index = items.indexOf(active!);
    // Focus inside a control we don't list (an editor, say): place it by
    // document order so Tab continues from there instead of restarting.
    if (
      index === -1 &&
      active &&
      active !== current &&
      current.contains(active)
    )
      index =
        items.findLastIndex(
          (el) =>
            active.compareDocumentPosition(el) &
            Node.DOCUMENT_POSITION_PRECEDING,
        ) + (event.shiftKey ? 1 : 0);
    if (
      event.shiftKey ? index <= 0 : index === -1 || index >= items.length - 1
    ) {
      event.preventDefault();
      items[event.shiftKey ? items.length - 1 : 0]!.focus();
    }
  };
  const keepFocus = (event: FocusEvent) => {
    if (current?.isConnected && !current.contains(event.target as Node))
      focus(current);
  };
  const observer = new MutationObserver(update);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("keydown", tab, true);
  document.addEventListener("keydown", escape);
  document.addEventListener("focusin", keepFocus, true);
  return () => {
    observer.disconnect();
    restoreInert();
    document.removeEventListener("keydown", tab, true);
    document.removeEventListener("keydown", escape);
    document.removeEventListener("focusin", keepFocus, true);
  };
}
