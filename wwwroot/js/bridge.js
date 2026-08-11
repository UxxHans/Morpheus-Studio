// Thin Promise wrapper around WebView2's postMessage <-> PostWebMessageAsJson,
// matching the {id, method, params} / {id, result|error} protocol in Services/Bridge.cs.
import { ICONS } from "./icons.js";

class Bridge {
  constructor() {
    this._nextId = 1;
    this._pending = new Map();
    if (window.chrome?.webview) {
      window.chrome.webview.addEventListener("message", (e) => this._onMessage(e.data));
    } else {
      console.warn("[bridge] window.chrome.webview not available (not running inside WebView2 host).");
    }
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!window.chrome?.webview) {
        reject(new Error("host bridge unavailable"));
        return;
      }
      const id = String(this._nextId++);
      this._pending.set(id, { resolve, reject });
      window.chrome.webview.postMessage({ id, method, params });
    });
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== "object" || !("id" in msg)) return;
    const entry = this._pending.get(msg.id);
    if (!entry) return;
    this._pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  }
}

export const bridge = new Bridge();

export function toast(message, isError = false) {
  const host = document.getElementById("toast");
  const el = document.createElement("div");
  el.className = "toast-item" + (isError ? " error" : "");
  el.innerHTML = (isError ? ICONS.alert(15) : ICONS.info(15)) + `<span>${escapeHtml(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => el.classList.add("leaving"), 3000);
  setTimeout(() => el.remove(), 3350);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// Styled stand-in for window.confirm(). Resolves true/false; never rejects.
export function confirmDialog(message, opts = {}) {
  const { title = "确认", confirmText = "确定", cancelText = "取消", danger = false } = opts;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog modal-confirm";

    const heading = document.createElement("h2");
    heading.textContent = title;

    const body = document.createElement("p");
    body.className = "modal-message";
    body.textContent = message;

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.innerHTML = ICONS.x(14);
    cancelBtn.append(document.createTextNode(cancelText));
    const okBtn = document.createElement("button");
    okBtn.className = danger ? "btn btn-solid-danger" : "btn btn-primary";
    okBtn.innerHTML = danger ? ICONS.trash(14) : ICONS.check(14);
    okBtn.append(document.createTextNode(confirmText));
    actions.append(cancelBtn, okBtn);

    dialog.append(heading, body, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    okBtn.focus();

    function close(result) {
      overlay.remove();
      resolve(result);
    }
    cancelBtn.addEventListener("click", () => close(false));
    okBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); close(false); }
    });
  });
}
