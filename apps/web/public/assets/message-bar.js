// @ts-check
// Makes a page's message bar (`messageBar` in apps/worker/src/notices.ts) a bar that sticks to the
// top of the viewport, so a person who has scrolled or zoomed in notices every message (design
// review). Without this script, the bar stays in the page's flow, where it is readable, and has
// nothing to close.
//
// - The bar sticks (`data-stuck`) only once the script runs, because only the script can close it,
//   and only while it is at most a third of the viewport's height. At 400% zoom the notice alone
//   is taller than the viewport, and a stuck bar that tall would hide whatever Tab moves to. A
//   bar too tall to stick stays in the page's flow, and scrolls away with it.
// - While the bar sticks, its height is the root's scroll padding (`--message-bar-height`), so a
//   control that Tab or Shift+Tab moves to is scrolled into view below the bar, never under it
//   (WCAG 2.4.11).
// - When a message arrives, the bar is scrolled into view if it isn't in view already: smoothly,
//   unless the person prefers reduced motion. A bar that is in view is left where it is, because
//   the scroll padding would otherwise count a stuck bar as out of view and move the page. If the
//   bar grew over the element that has focus, such as the heading that the delete dialog focused
//   before its message arrived, that element is scrolled into view below it. A script that moves
//   focus to its message, as the address form's does, still does.
// - Close hides the messages, and moves focus to the page's heading, so it doesn't fall to the
//   page with the hidden button. The page doesn't scroll to the heading, so a person who closed
//   the bar while reading further down stays where they were, and the next Tab goes on from the
//   top of the content. The live status regions are emptied, never hidden, because a
//   screen reader announces a change only in a region that is shown, so the next message in one
//   is announced as before. Any other message, such as a notice or an alert, is hidden, and shown
//   again when its content changes. A message that a page's own script hid, such as the search
//   page's note that it needs JavaScript, is left as it is.

const BAR_ID = "messages";
const CLOSE_LABEL = "Close";
// The button's name says what it closes, and starts with its visible label (WCAG 2.5.3).
const CLOSE_NAME = "Close messages";
// Marks a message that Close hid, so that only those are shown again.
const CLOSED = "closed";
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
// The largest share of the viewport's height that a stuck bar may take.
const STICKY_SHARE = 1 / 3;

/** How a scroll the script makes moves: smoothly, unless reduced motion is preferred. */
function scrollBehavior() {
  return REDUCED_MOTION.matches ? "instant" : "smooth";
}

/**
 * Whether a message in the bar shows anything: it is not hidden, and has text.
 * @param {Element} message
 */
function shows(message) {
  return !message.hasAttribute("hidden") && (message.textContent ?? "").trim() !== "";
}

/**
 * Whether the bar's box overlaps an element's: an element wholly above or below it, such as a
 * field the page has scrolled past, is not under it.
 * @param {DOMRect} bar
 * @param {DOMRect} element
 */
function covers(bar, element) {
  return element.top < bar.bottom && element.bottom > bar.top;
}

/** @param {HTMLElement} bar */
function enhance(bar) {
  const close = document.createElement("button");
  close.type = "button";
  close.className = "button button-small message-bar-close";
  close.textContent = CLOSE_LABEL;
  close.setAttribute("aria-label", CLOSE_NAME);

  // The bar's messages: every child but the Close button.
  const messages = () => [...bar.children].filter((child) => child !== close);

  // The button is shown only while there is something to close. Its `hidden` changes only when it
  // must, because the observer below watches `hidden` in the bar, and setting it, even to the same
  // value, would call this again, without end.
  const update = () => {
    const hidden = !messages().some(shows);
    if (close.hidden !== hidden) {
      close.hidden = hidden;
    }
  };

  close.addEventListener("click", () => {
    for (const message of messages()) {
      if (message.getAttribute("role") === "status") {
        message.replaceChildren();
      } else if (!message.hasAttribute("hidden")) {
        message.setAttribute("hidden", "");
        message.setAttribute(`data-${CLOSED}`, "");
      }
    }
    // The page's heading takes focus, at the top of the page's content, which tabindex -1 allows
    // without adding it to the Tab order.
    const heading = document.querySelector("main h1");
    if (heading instanceof HTMLElement) {
      if (!heading.hasAttribute("tabindex")) {
        heading.tabIndex = -1;
      }
      heading.focus({ preventScroll: true });
    }
    update();
  });

  // Sticks the bar while it fits, and keeps the root's scroll padding at the stuck bar's height.
  const stick = () => {
    const height = bar.getBoundingClientRect().height;
    const fits = height > 0 && height <= window.innerHeight * STICKY_SHARE;
    if (fits !== (bar.dataset.stuck !== undefined)) {
      bar.toggleAttribute("data-stuck", fits);
    }
    document.documentElement.style.setProperty("--message-bar-height", `${fits ? height : 0}px`);
  };

  // Brings a new message into view, and the focused element out from under the bar.
  const reveal = () => {
    stick();
    const box = bar.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) {
      bar.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
      return;
    }
    const active = document.activeElement;
    if (
      bar.dataset.stuck !== undefined &&
      active instanceof HTMLElement &&
      active !== document.body &&
      !bar.contains(active) &&
      covers(box, active.getBoundingClientRect())
    ) {
      active.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
    }
  };

  // A message added to the bar, such as the address form's error, or a change to the content of
  // one, is a new message. A message that Close hid is shown again when its content changes, and
  // the bar is scrolled into view if the change added anything to read. A change that only
  // removed something, such as Close emptying a status region, scrolls nothing. A message hidden
  // or shown, by Close or by a page's script, only decides whether Close is shown.
  const observer = new MutationObserver((records) => {
    let arrived = false;
    for (const record of records) {
      if (record.type === "attributes") {
        continue;
      }
      if (record.target === bar) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node !== close) {
            arrived ||= shows(node);
          }
        }
        continue;
      }
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const message = messages().find((child) => child.contains(target));
      if (message === undefined) {
        continue;
      }
      if (message.hasAttribute(`data-${CLOSED}`)) {
        message.removeAttribute("hidden");
        message.removeAttribute(`data-${CLOSED}`);
      }
      if (record.type === "characterData" || record.addedNodes.length > 0) {
        arrived ||= shows(message);
      }
    }
    update();
    if (arrived) {
      reveal();
    }
  });

  // The bar's height changes with its messages and the text size, and the viewport's with the
  // window and the zoom, so both decide again whether the bar sticks.
  const resize = new ResizeObserver(stick);

  bar.append(close);
  update();
  bar.dataset.enhanced = "";
  observer.observe(bar, {
    childList: true,
    characterData: true,
    subtree: true,
    attributeFilter: ["hidden"],
  });
  resize.observe(bar);
  window.addEventListener("resize", stick);
}

const bar = document.getElementById(BAR_ID);
if (bar !== null && bar.dataset.enhanced === undefined) {
  enhance(bar);
}
