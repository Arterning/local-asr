import { appendSegment, createSession, getSession, listSessions, updateSession } from "./storage/transcript-db.js";

const DEFAULT_SETTINGS = {
  serverUrl: "ws://127.0.0.1:8000/ws/asr",
  fontSize: 28,
  position: "bottom",
  opacity: 78,
  keepAudio: true,
};

const EMPTY_STATE = {
  status: "idle", tabId: null, tabTitle: "", partial: "", final: "",
  error: "", sessionId: null, videoTime: null, videoDuration: null,
};
let state = { ...EMPTY_STATE };
let segmentSaveQueue = Promise.resolve();
const stateReady = chrome.storage.session.get("runtimeState").then(async ({ runtimeState }) => {
  if (runtimeState) {
    state = { ...EMPTY_STATE, ...runtimeState };
    return;
  }
  const staleSessions = (await listSessions()).filter((session) => session.status === "recording");
  await Promise.all(staleSessions.map((session) => updateSession(session.id, {
    status: "interrupted",
    completedAt: Date.now(),
  })));
});

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL("offscreen/offscreen.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
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
  await chrome.storage.session.set({ runtimeState: state });
  const snapshot = { type: "STATE_CHANGED", state: { ...state } };
  chrome.runtime.sendMessage(snapshot).catch(() => {});
  if (state.tabId !== null) chrome.tabs.sendMessage(state.tabId, snapshot).catch(() => {});
}

function platformFromUrl(url) {
  if (url.includes("youtube.com")) return "youtube";
  if (url.includes("bilibili.com")) return "bilibili";
  return "unknown";
}

async function startCapture(tabId) {
  await stateReady;
  if (state.status !== "idle" && state.tabId !== null) await stopCapture();
  const tab = await chrome.tabs.get(tabId);
  const supported = /^https:\/\/(www\.)?(youtube\.com|bilibili\.com)\//.test(tab.url || "");
  if (!supported) throw new Error("请在 YouTube 或哔哩哔哩视频页面使用此插件");

  const session = await createSession({
    title: tab.title || "当前视频",
    url: tab.url || "",
    platform: platformFromUrl(tab.url || ""),
  });
  state = { ...EMPTY_STATE, status: "connecting", tabId, tabTitle: session.title, sessionId: session.id };
  await broadcastState();

  try {
    await ensureOffscreenDocument();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const response = await chrome.runtime.sendMessage({
      target: "offscreen", type: "START_CAPTURE", streamId, tabId, settings: await getSettings(),
    });
    if (!response?.ok) throw new Error(response?.error || "无法启动标签页音频捕获");
  } catch (error) {
    await updateSession(session.id, { status: "failed", completedAt: Date.now() });
    throw error;
  }
}

async function finishSession(status = "completed") {
  if (state.sessionId) await updateSession(state.sessionId, { status, completedAt: Date.now() });
}

async function stopCapture() {
  await stateReady;
  const previousTabId = state.tabId;
  await finishSession(state.status === "error" ? "interrupted" : "completed");
  await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_CAPTURE" }).catch(() => {});
  state = { ...EMPTY_STATE, final: state.final };
  await broadcastState();
  if (previousTabId !== null) chrome.tabs.sendMessage(previousTabId, { type: "CAPTURE_STOPPED" }).catch(() => {});
}

async function saveFinalSegment(text) {
  await stateReady;
  if (!state.sessionId || !text) return;
  const session = await getSession(state.sessionId);
  if (!session) return;
  let endTime = Number.isFinite(state.videoTime) ? state.videoTime : Math.max(0, (Date.now() - session.createdAt) / 1000);
  const estimatedLength = Math.max(1.2, Math.min(8, text.length / 4));
  let startTime = session.lastVideoTime;
  if (!Number.isFinite(startTime) || endTime < startTime || endTime - startTime > 30) {
    startTime = Math.max(0, endTime - estimatedLength);
  }
  if (endTime <= startTime) endTime = startTime + 0.8;
  await appendSegment(state.sessionId, { text, startTime, endTime });
}

async function handleOffscreenStatus(message) {
  await stateReady;
  if (message.status === "error") await finishSession("interrupted");
  state = { ...state, status: message.status, error: message.error || "" };
  if (message.status === "idle") state = { ...EMPTY_STATE, final: state.final };
  await broadcastState();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "offscreen") return false;
  if (message.type === "GET_STATE") {
    stateReady.then(async () => {
      const visibleState = sender.tab && sender.tab.id !== state.tabId ? { ...EMPTY_STATE } : { ...state };
      sendResponse({ state: visibleState, settings: await getSettings() });
    });
    return true;
  }
  if (message.type === "START_CAPTURE") {
    startCapture(message.tabId).then(() => sendResponse({ ok: true })).catch(async (error) => {
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
  if (message.type === "OPEN_HISTORY") {
    chrome.tabs.create({ url: chrome.runtime.getURL("history/history.html") });
    return false;
  }
  if (message.type === "VIDEO_STATE") {
    stateReady.then(() => {
      if (sender.tab?.id === state.tabId) {
        state.videoTime = Number.isFinite(message.currentTime) ? message.currentTime : state.videoTime;
        state.videoDuration = Number.isFinite(message.duration) ? message.duration : state.videoDuration;
      }
    });
    return false;
  }
  if (message.type === "SETTINGS_CHANGED") {
    stateReady.then(() => {
      if (state.tabId === null) return;
      chrome.tabs.sendMessage(state.tabId, { type: "SETTINGS_CHANGED", settings: message.settings }).catch(() => {});
      chrome.runtime.sendMessage({ target: "offscreen", type: "SETTINGS_CHANGED", settings: message.settings }).catch(() => {});
    });
    return false;
  }
  if (message.type === "OFFSCREEN_STATUS") {
    handleOffscreenStatus(message);
    return false;
  }
  if (message.type === "ASR_RESULT") {
    stateReady.then(async () => {
      if (message.resultType === "partial") state.partial = message.text;
      if (message.resultType === "final") {
        state.final = message.text;
        state.partial = "";
        segmentSaveQueue = segmentSaveQueue.then(() => saveFinalSegment(message.text))
          .catch((error) => console.error("Failed to save transcript segment", error));
      }
      await broadcastState();
    });
    return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stateReady.then(() => { if (tabId === state.tabId) stopCapture(); });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  stateReady.then(() => {
    if (tabId === state.tabId && changeInfo.status === "loading") {
      chrome.tabs.sendMessage(tabId, { type: "STATE_CHANGED", state }).catch(() => {});
    }
  });
});
