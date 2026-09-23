const DEFAULT_SETTINGS = {
  serverUrl: "ws://127.0.0.1:8000/ws/asr",
  fontSize: 28,
  position: "bottom",
  opacity: 78,
  keepAudio: true,
};

let state = {
  status: "idle",
  tabId: null,
  tabTitle: "",
  partial: "",
  final: "",
  error: "",
};

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL("offscreen/offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (contexts.length) return;

  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture and process the selected tab audio for live subtitles",
  });
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
}

async function broadcastState() {
  const snapshot = { type: "STATE_CHANGED", state: { ...state } };
  chrome.runtime.sendMessage(snapshot).catch(() => {});
  if (state.tabId !== null) {
    chrome.tabs.sendMessage(state.tabId, snapshot).catch(() => {});
  }
}

async function startCapture(tabId) {
  if (state.status !== "idle" && state.tabId !== null) {
    await stopCapture();
  }

  const tab = await chrome.tabs.get(tabId);
  const supported = /^https:\/\/(www\.)?(youtube\.com|bilibili\.com)\//.test(tab.url || "");
  if (!supported) throw new Error("请在 YouTube 或哔哩哔哩视频页面使用此插件");

  state = {
    status: "connecting",
    tabId,
    tabTitle: tab.title || "当前标签页",
    partial: "",
    final: "",
    error: "",
  };
  await broadcastState();

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const settings = await getSettings();
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "START_CAPTURE",
    streamId,
    tabId,
    settings,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "无法启动标签页音频捕获");
  }
}

async function stopCapture() {
  await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_CAPTURE" }).catch(() => {});
  const previousTabId = state.tabId;
  state = { ...state, status: "idle", tabId: null, partial: "", error: "" };
  await broadcastState();
  if (previousTabId !== null) {
    chrome.tabs.sendMessage(previousTabId, { type: "CAPTURE_STOPPED" }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "offscreen") return false;

  if (message.type === "GET_STATE") {
    const visibleState = sender.tab && sender.tab.id !== state.tabId
      ? { ...state, status: "idle", tabId: null, partial: "", final: "", error: "" }
      : { ...state };
    getSettings().then((settings) => sendResponse({ state: visibleState, settings }));
    return true;
  }

  if (message.type === "START_CAPTURE") {
    startCapture(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(async (error) => {
        state = { ...state, status: "error", error: error.message || String(error) };
        await broadcastState();
        sendResponse({ ok: false, error: state.error });
      });
    return true;
  }

  if (message.type === "STOP_CAPTURE") {
    stopCapture().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "SETTINGS_CHANGED") {
    if (state.tabId !== null) {
      chrome.tabs.sendMessage(state.tabId, {
        type: "SETTINGS_CHANGED",
        settings: message.settings,
      }).catch(() => {});
      chrome.runtime.sendMessage({
        target: "offscreen",
        type: "SETTINGS_CHANGED",
        settings: message.settings,
      }).catch(() => {});
    }
    return false;
  }

  if (message.type === "OFFSCREEN_STATUS") {
    state = {
      ...state,
      status: message.status,
      error: message.error || "",
    };
    if (message.status === "idle") state.tabId = null;
    broadcastState();
    return false;
  }

  if (message.type === "ASR_RESULT") {
    if (message.resultType === "partial") {
      state.partial = message.text;
    } else if (message.resultType === "final") {
      state.final = message.text;
      state.partial = "";
    }
    broadcastState();
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) stopCapture();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === state.tabId && changeInfo.status === "loading") {
    chrome.tabs.sendMessage(tabId, { type: "STATE_CHANGED", state }).catch(() => {});
  }
});
