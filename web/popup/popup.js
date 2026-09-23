const elements = {
  status: document.querySelector("#status"),
  tabTitle: document.querySelector("#tabTitle"),
  serverUrl: document.querySelector("#serverUrl"),
  error: document.querySelector("#errorMessage"),
  toggle: document.querySelector("#toggleButton"),
  transcript: document.querySelector("#transcript"),
  copy: document.querySelector("#copyButton"),
  fontSize: document.querySelector("#fontSize"),
  fontSizeValue: document.querySelector("#fontSizeValue"),
  position: document.querySelector("#position"),
  opacity: document.querySelector("#opacity"),
  opacityValue: document.querySelector("#opacityValue"),
  keepAudio: document.querySelector("#keepAudio"),
};

let activeTab = null;
let currentState = { status: "idle", final: "", partial: "", error: "" };

const statusLabels = {
  idle: "未启动",
  connecting: "连接中",
  capturing: "识别中",
  error: "发生错误",
};

function renderState(state) {
  currentState = state;
  const status = statusLabels[state.status] ? state.status : "idle";
  elements.status.className = `status ${status}`;
  elements.status.querySelector("b").textContent = statusLabels[status];
  elements.toggle.textContent = status === "capturing" || status === "connecting" ? "停止识别" : "开始识别";
  elements.toggle.classList.toggle("stop", status === "capturing" || status === "connecting");
  elements.error.hidden = !state.error;
  elements.error.textContent = state.error || "";

  const text = [state.final, state.partial].filter(Boolean).join("\n");
  elements.transcript.textContent = text || "识别结果将在这里显示";
  elements.transcript.classList.toggle("empty", !text);
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
  renderState(response.state);
  renderSettings(response.settings);
}

elements.toggle.addEventListener("click", async () => {
  elements.toggle.disabled = true;
  try {
    if (currentState.status === "capturing" || currentState.status === "connecting") {
      await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    } else {
      await saveSettings();
      const response = await chrome.runtime.sendMessage({ type: "START_CAPTURE", tabId: activeTab.id });
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
  const text = [currentState.final, currentState.partial].filter(Boolean).join("\n");
  if (!text) return;
  await navigator.clipboard.writeText(text);
  elements.copy.textContent = "已复制";
  setTimeout(() => { elements.copy.textContent = "复制"; }, 1200);
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
