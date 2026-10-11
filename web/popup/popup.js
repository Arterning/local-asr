import { getSegments } from "../storage/transcript-db.js";
const elements = {
  source: document.querySelector("#sourceMode"),
  serverCard: document.querySelector("#serverCard"),
  sourceHint: document.querySelector("#sourceHint"),
  trackControls: document.querySelector("#trackControls"),
  track: document.querySelector("#subtitleTrack"),
  summary: document.querySelector("#subtitleSummary"),
  status: document.querySelector("#status"),
  tabTitle: document.querySelector("#tabTitle"),
  serverUrl: document.querySelector("#serverUrl"),
  error: document.querySelector("#errorMessage"),
  toggle: document.querySelector("#toggleButton"),
  transcript: document.querySelector("#transcript"),
  copy: document.querySelector("#copyButton"),
  history: document.querySelector("#historyButton"),
  fontSize: document.querySelector("#fontSize"),
  fontSizeValue: document.querySelector("#fontSizeValue"),
  position: document.querySelector("#position"),
  opacity: document.querySelector("#opacity"),
  opacityValue: document.querySelector("#opacityValue"),
  keepAudio: document.querySelector("#keepAudio"),
};

let activeTab = null;
let currentState = { status: "idle", final: "", partial: "", error: "" };
let nativeText = "";
let previewSession = null;
const running = state => ["capturing", "connecting", "loading", "subtitles"].includes(state.status);
function renderMode() {
  const native = elements.source.value !== "asr";
  elements.serverCard.hidden = native;
  elements.sourceHint.textContent = native
    ? "直接读取字幕和时间轴，无需启动识别服务。无可用字幕时，可切换本地语音识别。"
    : "支持普通网站的标签页声音，不限 B 站或 YouTube；需要启动本地识别服务。";
  if (!running(currentState)) elements.toggle.textContent = native ? "读取视频字幕" : "开始识别";
}

const statusLabels = {
  idle: "未启动",
  connecting: "连接中",
  capturing: "识别中",
  error: "发生错误",
  loading: "读取中",
  subtitles: "视频字幕",
};

function renderState(state) {
  currentState = state;
  if (running(state)) elements.source.value = state.source === "native" ? (state.provider === "youtube" ? "youtube" : "native") : "asr";
  const status = statusLabels[state.status] ? state.status : "idle";
  elements.status.className = `status ${status}`;
  elements.status.querySelector("b").textContent = statusLabels[status];
  elements.toggle.textContent = status === "capturing" || status === "connecting" ? "停止识别" : "开始识别";
  elements.toggle.classList.toggle("stop", status === "capturing" || status === "connecting");
  if (running(state)) elements.toggle.textContent = state.source === "native" ? "停止字幕显示" : "停止识别";
  elements.toggle.classList.toggle("stop", running(state));
  elements.source.disabled = running(state);
  elements.trackControls.hidden = status !== "subtitles";
  elements.track.replaceChildren(...(state.tracks || []).map(track => {
    const option = document.createElement("option");
    option.value = track.id; option.textContent = track.label;
    return option;
  }));
  elements.track.value = state.trackId || "";
  elements.summary.textContent = `已保存 ${state.segmentCount || 0} 条字幕，可查看全文或导出。切换语言会另存一份记录。`;
  elements.error.hidden = !state.error;
  elements.error.textContent = state.error || "";

  const text = [state.final, state.partial].filter(Boolean).join("\n");
  elements.transcript.textContent = text || "字幕将在这里显示";
  elements.transcript.classList.toggle("empty", !text);
  renderMode();
  if (status === "subtitles") {
    if (previewSession !== state.sessionId) {
      previewSession = state.sessionId;
      nativeText = "";
      getSegments(state.sessionId).then(segments => {
        if (currentState.sessionId !== state.sessionId || currentState.status !== "subtitles") return;
        nativeText = segments.map(s => s.text).join("\n");
        elements.transcript.textContent = nativeText;
        elements.transcript.classList.remove("empty");
      }).catch(error => { elements.error.hidden = false; elements.error.textContent = error.message; });
    } else {
      elements.transcript.textContent = nativeText;
      elements.transcript.classList.toggle("empty", !nativeText);
    }
  } else { previewSession = null; nativeText = ""; }
}

function renderSettings(settings) {
  elements.serverUrl.value = settings.serverUrl;
  elements.fontSize.value = settings.fontSize;
  elements.fontSizeValue.value = `${settings.fontSize}px`;
  elements.position.value = settings.position;
  elements.opacity.value = settings.opacity;
  elements.opacityValue.value = `${settings.opacity}%`;
  elements.keepAudio.checked = settings.keepAudio;
}

async function saveSettings() {
  const settings = {
    serverUrl: elements.serverUrl.value.trim(),
    fontSize: Number(elements.fontSize.value),
    position: elements.position.value,
    opacity: Number(elements.opacity.value),
    keepAudio: elements.keepAudio.checked,
  };
  await chrome.storage.local.set(settings);
  chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED", settings }).catch(() => {});
}

async function initialize() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  elements.tabTitle.textContent = activeTab?.title || "无法读取当前标签页";
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  const { subtitleSource = "native" } = await chrome.storage.local.get("subtitleSource");
  elements.source.value = ["native", "youtube", "asr"].includes(subtitleSource) ? subtitleSource : "native";
  renderState(response.state);
  renderSettings(response.settings);
}

elements.toggle.addEventListener("click", async () => {
  elements.toggle.disabled = true;
  try {
    if (running(currentState)) {
      await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    } else {
      await saveSettings();
      const response = await chrome.runtime.sendMessage({ type: elements.source.value !== "asr" ? "START_NATIVE" : "START_CAPTURE",
        provider: elements.source.value === "youtube" ? "youtube" : "bilibili", tabId: activeTab.id });
      if (!response.ok) throw new Error(response.error);
    }
  } catch (error) {
    elements.error.hidden = false;
    elements.error.textContent = error.message || String(error);
  } finally {
    elements.toggle.disabled = false;
  }
});

elements.copy.addEventListener("click", async () => {
  const text = currentState.status === "subtitles" ? nativeText : [currentState.final, currentState.partial].filter(Boolean).join("\n");
  if (!text) return;
  await navigator.clipboard.writeText(text);
  elements.copy.textContent = "已复制";
  setTimeout(() => { elements.copy.textContent = "复制"; }, 1200);
});

elements.history.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_HISTORY" });
});

elements.source.addEventListener("change", () => {
  renderMode();
  chrome.storage.local.set({ subtitleSource: elements.source.value });
});
elements.track.addEventListener("change", async () => {
  const trackId = elements.track.value;
  elements.track.disabled = true;
  elements.toggle.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "START_NATIVE", tabId: currentState.tabId, trackId,
      provider: currentState.provider || "bilibili" });
    if (!response.ok) throw new Error(response.error);
  } catch (error) { elements.error.hidden = false; elements.error.textContent = error.message; }
  finally { elements.track.disabled = false; elements.toggle.disabled = false; }
});

for (const element of [elements.serverUrl, elements.position, elements.keepAudio]) {
  element.addEventListener("change", saveSettings);
}
elements.fontSize.addEventListener("input", () => {
  elements.fontSizeValue.value = `${elements.fontSize.value}px`;
  saveSettings();
});
elements.opacity.addEventListener("input", () => {
  elements.opacityValue.value = `${elements.opacity.value}%`;
  saveSettings();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE_CHANGED") renderState(message.state);
});

initialize().catch((error) => {
  elements.error.hidden = false;
  elements.error.textContent = error.message || String(error);
});
