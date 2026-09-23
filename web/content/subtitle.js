const HOST_ID = "live-subtitle-extension-host";
let host = null;
let finalLine = "";
let settings = { fontSize: 28, position: "bottom", opacity: 78 };
let hideTimer = null;
let trackingVideo = false;

function ensureOverlay() {
  if (host?.isConnected) return host;
  host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      .wrap { position: absolute; left: 10%; width: 80%; display: flex; justify-content: center; transition: opacity .2s ease; }
      .wrap.bottom { bottom: 11%; }
      .wrap.middle { top: 50%; transform: translateY(-50%); }
      .wrap.top { top: 9%; }
      .box { max-width: 100%; padding: .36em .7em .42em; border-radius: .38em; text-align: center; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; line-height: 1.42; color: white; background: rgba(0,0,0,.78); box-shadow: 0 2px 12px rgba(0,0,0,.24); white-space: pre-wrap; overflow-wrap: anywhere; }
      .final:empty { display: none; }
      .partial { color: rgba(255,255,255,.76); }
      .partial:empty { display: none; }
      .notice { color: #ffd875; font-size: .65em; }
      .hidden { opacity: 0; }
    </style>
    <div class="wrap hidden bottom">
      <div class="box">
        <div class="final"></div>
        <div class="partial"></div>
        <div class="notice"></div>
      </div>
    </div>`;
  attachToVisibleRoot();
  applySettings();
  return host;
}

function attachToVisibleRoot() {
  if (!host) return;
  const root = document.fullscreenElement || document.documentElement;
  if (host.parentNode !== root) root.appendChild(host);
}

function applySettings() {
  if (!host) return;
  const wrap = host.shadowRoot.querySelector(".wrap");
  wrap.classList.remove("top", "middle", "bottom");
  wrap.classList.add(settings.position || "bottom");
  host.shadowRoot.querySelector(".box").style.cssText = `font-size:${settings.fontSize || 28}px;background:rgba(0,0,0,${(settings.opacity || 78) / 100})`;
}

function render(state) {
  trackingVideo = state.status === "capturing" || state.status === "connecting";
  ensureOverlay();
  const wrap = host.shadowRoot.querySelector(".wrap");
  const final = host.shadowRoot.querySelector(".final");
  const partial = host.shadowRoot.querySelector(".partial");
  const notice = host.shadowRoot.querySelector(".notice");

  if (state.status === "error") {
    notice.textContent = state.error || "识别服务已断开";
    wrap.classList.remove("hidden");
    return;
  }
  notice.textContent = "";
  if (state.status === "idle") {
    wrap.classList.add("hidden");
    final.textContent = "";
    partial.textContent = "";
    finalLine = "";
    return;
  }
  if (state.final) finalLine = state.final;
  final.textContent = finalLine;
  partial.textContent = state.partial || "";
  wrap.classList.toggle("hidden", !finalLine && !state.partial);

  clearTimeout(hideTimer);
  if (finalLine && !state.partial) {
    hideTimer = setTimeout(() => wrap.classList.add("hidden"), 5000);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE_CHANGED") render(message.state);
  if (message.type === "SETTINGS_CHANGED") {
    settings = { ...settings, ...message.settings };
    ensureOverlay();
    applySettings();
  }
  if (message.type === "CAPTURE_STOPPED") render({ status: "idle" });
});

document.addEventListener("fullscreenchange", () => {
  requestAnimationFrame(attachToVisibleRoot);
});

chrome.storage.local.get(settings).then((stored) => {
  settings = { ...settings, ...stored };
});

chrome.runtime.sendMessage({ type: "GET_STATE" }).then((response) => {
  settings = { ...settings, ...response.settings };
  if (response.state.tabId) render(response.state);
}).catch(() => {});

function reportVideoState() {
  if (!trackingVideo) return;
  const videos = [...document.querySelectorAll("video")];
  const video = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  if (!video) return;
  chrome.runtime.sendMessage({
    type: "VIDEO_STATE",
    currentTime: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : null,
    paused: video.paused,
    playbackRate: video.playbackRate,
  }).catch(() => {});
}

setInterval(reportVideoState, 500);
reportVideoState();
