// @ts-check
// Makes a page's message bar (`messageBar` in apps/worker/src/notices.ts) a bar that sticks to the
// top of the viewport, so a person who has scrolled or zoomed in notices every message (design
// review). Without this script, the bar stays in the page's flow, where it is readable, and has
// nothing to close.
//
// - The bar sticks only once the script runs (`data-enhanced`), because only the script can close
//   it, and a bar that can't close could cover most of the viewport at 400% zoom.
// - The bar's height is the root's scroll padding (`--message-bar-height`), so a control that Tab
//   or Shift+Tab moves to is scrolled into view below the bar, never under it (WCAG 2.4.11).
// - When a message arrives, the bar is scrolled into view: smoothly, unless the person prefers
//   reduced motion. A script that moves focus to its message, as the address form's does, still
//   does, and focus scrolls the message into view too.
// - Close hides the messages, and moves focus to the page's heading, so it doesn't fall to the
//   page with the hidden button. The live status regions are emptied, never hidden, because a
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

/**
 * Whether a message in the bar shows anything: it is not hidden, and has text.
 * @param {Element} message
 */
function shows(message) {
  return !message.hasAttribute("hidden") && (message.textContent ?? "").trim() !== "";
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
      heading.focus();
    }
    update();
  });

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
      bar.scrollIntoView({
        block: "nearest",
        behavior: REDUCED_MOTION.matches ? "instant" : "smooth",
      });
    }
  });

  // The bar's height, for the root's scroll padding.
  const resize = new ResizeObserver(() => {
    document.documentElement.style.setProperty(
      "--message-bar-height",
      `${bar.getBoundingClientRect().height}px`,
    );
  });

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
}

const bar = document.getElementById(BAR_ID);
if (bar !== null && bar.dataset.enhanced === undefined) {
  enhance(bar);
}
