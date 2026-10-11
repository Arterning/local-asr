// This function is self-contained: Chrome serializes it into the page's MAIN world.
async function youtubePage(operation, selectedTrack) {
  try {
    const pageUrl = new URL(location.href);
    const videoId = pageUrl.pathname === "/watch" && pageUrl.searchParams.get("v");
    if (!/^(www\.)?youtube\.com$/.test(pageUrl.hostname) || !videoId) {
      throw new Error("请在 YouTube 普通视频页面（/watch?v=…）读取字幕");
    }
    const player = document.querySelector("#movie_player");
    const sameVideo = () => new URL(location.href).searchParams.get("v") === videoId;
    let response = player?.getPlayerResponse?.();
    if (response?.videoDetails?.videoId !== videoId) response = window.ytInitialPlayerResponse;
    if (response?.videoDetails?.videoId !== videoId) throw new Error("播放器尚未加载当前视频，请稍候或刷新后重试");
    if (response.videoDetails.isLive) throw new Error("暂不支持直播中的字幕，请使用本地语音识别");
    const captions = response.captions?.playerCaptionsTracklistRenderer;
    const tracks = (captions?.captionTracks || []).filter(t => t.baseUrl && t.languageCode).map((t, i) => ({
      id: t.vssId || `${t.languageCode}:${t.kind || "manual"}:${i}`,
      language: t.languageCode,
      label: `${t.name?.simpleText || t.name?.runs?.map(r => r.text).join("") || t.languageCode}${t.kind === "asr" ? " · 自动生成" : " · 人工字幕"}`,
      automatic: t.kind === "asr", url: t.baseUrl, videoId,
    }));
    if (!tracks.length) throw new Error("当前视频没有可读取的字幕轨；若播放器有 CC 字幕，请播放视频并刷新后重试");
    if (operation === "discover") return {
      tracks, key: `youtube:${videoId}`, url: location.href,
      title: response.videoDetails.title || document.title,
    };
    if (selectedTrack.videoId !== videoId) throw new Error("视频已切换，请重新读取字幕");
    const track = tracks.find(t => t.id === selectedTrack.id);
    if (!track) throw new Error("字幕轨已变化，请重新读取");
    const base = new URL(track.url, location.origin);
    if (base.protocol !== "https:" || !/^(www\.)?youtube\.com$/.test(base.hostname) || base.pathname !== "/api/timedtext") {
      throw new Error("YouTube 字幕文件地址不受支持");
    }
    const matches = address => {
      try {
        const url = new URL(address, location.origin);
        return url.origin === base.origin && url.pathname === base.pathname
          && url.searchParams.get("v") === videoId
          && url.searchParams.get("lang") === base.searchParams.get("lang")
          && (url.searchParams.get("kind") || "") === (base.searchParams.get("kind") || "")
          && (url.searchParams.get("name") || "") === (base.searchParams.get("name") || "")
          && !url.searchParams.has("tlang");
      } catch { return false; }
    };
    const parse = text => {
      if (!text.trim()) throw new Error("字幕接口返回空内容");
      if (text.trim().startsWith("{")) {
        const json = JSON.parse(text);
        if (!json.events?.some(e => e.segs?.some(s => s.utf8?.trim()))) throw new Error("字幕文件没有有效内容");
        return json;
      }
      const xml = new DOMParser().parseFromString(text, "text/xml");
      if (xml.querySelector("parsererror")) throw new Error("字幕格式无法解析");
      const events = [...xml.querySelectorAll("text, body > p")].map(row => {
        const legacy = row.tagName === "text";
        return { tStartMs: Number(row.getAttribute(legacy ? "start" : "t")) * (legacy ? 1000 : 1),
          dDurationMs: Number(row.getAttribute(legacy ? "dur" : "d")) * (legacy ? 1000 : 1),
          wWinId: row.getAttribute("w") || 0, aAppend: row.getAttribute("a") === "1" ? 1 : 0,
          segs: [{ utf8: row.textContent }] };
      });
      if (!events.length) throw new Error("字幕格式无法解析");
      return { events };
    };
    const request = async address => {
      const result = await fetch(address, { credentials: "include", signal: AbortSignal.timeout(6000) });
      if (!result.ok) throw new Error(`YouTube 字幕请求失败（HTTP ${result.status}）`);
      const data = parse(await result.text());
      if (!sameVideo()) throw new Error("视频已切换，请重新读取字幕");
      return data;
    };
    // Prefer a URL already issued by the player, including its validation parameters.
    const observed = performance.getEntriesByType("resource").map(e => e.name).filter(matches).at(-1);
    const direct = new URL(base); direct.searchParams.set("fmt", "json3");
    try { return { data: await request(observed || direct.href) }; } catch { /* Use the real player's request below. */ }
    if (!sameVideo()) throw new Error("视频已切换，请重新读取字幕");
    if (!player?.setOption || !player?.getOption || !player?.loadModule) {
      throw new Error("字幕请求未通过校验，请先打开 YouTube 的 CC 字幕再重试");
    }

    // Capture only this track's response, without storing cookies or generating tokens.
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const previousTrack = player.getOption("captions", "track");
    const previouslyEnabled = document.querySelector(".ytp-subtitles-button")?.getAttribute("aria-pressed") === "true";
    const xhrListeners = new Map();
    let timer;
    let settle;
    let active = true;
    const pending = new Promise((resolve, reject) => {
      settle = resolve;
      timer = setTimeout(() => reject(new Error("未能获得 YouTube 字幕内容，请打开播放器 CC 字幕后重试；也可使用本地语音识别")), 12000);
    });
    const accept = text => {
      if (!active || !sameVideo()) return;
      try { settle(parse(text)); } catch { /* Ignore empty or unsuccessful responses. */ }
    };
    const wrappedFetch = function (...args) {
      const result = originalFetch.apply(this, args);
      const address = typeof args[0] === "string" ? args[0] : args[0]?.url || String(args[0]);
      if (matches(address)) result.then(r => { if (r.ok) r.clone().text().then(accept).catch(() => {}); }).catch(() => {});
      return result;
    };
    const wrappedOpen = function (method, address, ...rest) {
      const old = xhrListeners.get(this);
      if (old) { this.removeEventListener("load", old); xhrListeners.delete(this); }
      if (matches(String(address))) {
        const onLoad = () => {
          if (this.status === 200) {
            try { accept(this.responseType === "json" ? JSON.stringify(this.response) : this.responseText); } catch { /* Unsupported response type. */ }
          }
        };
        xhrListeners.set(this, onLoad);
        this.addEventListener("load", onLoad);
      }
      return originalOpen.call(this, method, address, ...rest);
    };
    window.fetch = wrappedFetch;
    XMLHttpRequest.prototype.open = wrappedOpen;
    try {
      player.loadModule("captions");
      player.setOption("captions", "track", {});
      player.setOption("captions", "track", { languageCode: track.language,
        kind: track.automatic ? "asr" : "", vssId: track.id, name: base.searchParams.get("name") || "" });
      return { data: await pending };
    } finally {
      active = false;
      clearTimeout(timer);
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalOpen;
      for (const [xhr, listener] of xhrListeners) xhr.removeEventListener("load", listener);
      // Do not restore a different video's settings after SPA navigation.
      if (sameVideo()) {
        try {
          if (previouslyEnabled) player.setOption("captions", "track", previousTrack || {});
          else player.unloadModule?.("captions");
        } catch { /* Player may have been disposed. */ }
      }
    }
  } catch (error) {
    return { error: error.name === "TimeoutError" ? "YouTube 请求超时，请检查网络后重试" : error.message };
  }
}

async function runInPage(tabId, operation, track = null) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN",
    func: youtubePage, args: [operation, track] });
  if (!result?.result || result.result.error) throw new Error(result?.result?.error || "无法读取 YouTube，请刷新视频页面后重试");
  return result.result;
}

export const discoverTracks = tabId => runInPage(tabId, "discover");
export async function downloadTrack(track, tabId) {
  const { data } = await runInPage(tabId, "download", track);
  return parseSubtitle(data, track.automatic);
}

export function parseSubtitle(data, automatic = false) {
  const cues = [];
  const windows = new Map();
  for (const event of data.events || []) {
    const text = (event.segs || []).map(s => typeof s.utf8 === "string" ? s.utf8 : "").join("");
    const startTime = event.tStartMs / 1000;
    const endTime = startTime + event.dDurationMs / 1000;
    if (!Number.isFinite(startTime) || startTime < 0 || !Number.isFinite(endTime) || endTime <= startTime) continue;
    const previous = windows.get(event.wWinId ?? 0);
    if (event.aAppend && previous && startTime <= previous.endTime) {
      previous.text += text;
      previous.endTime = Math.max(previous.endTime, endTime);
      continue;
    }
    if (!text.trim()) continue;
    const cue = { text, startTime, endTime };
    cues.push(cue);
    windows.set(event.wWinId ?? 0, cue);
  }
  const segments = [];
  for (const cue of cues.sort((a, b) => a.startTime - b.startTime)) {
    cue.text = cue.text.replace(/\s+/g, " ").trim();
    if (!cue.text) continue;
    const previous = segments.at(-1);
    if (automatic && previous && cue.startTime < previous.endTime) {
      if (previous.text === cue.text) { previous.endTime = Math.max(previous.endTime, cue.endTime); continue; }
      if (cue.startTime === previous.startTime) {
        previous.text = cue.text;
        previous.endTime = Math.max(previous.endTime, cue.endTime);
        continue;
      }
      // Remove repeated roll-up prefixes only across overlapping cues, not later repetitions.
      const before = previous.text.split(" "); const after = cue.text.split(" ");
      for (let count = Math.min(before.length, after.length); count >= 2; count--) {
        if (before.slice(-count).join(" ") === after.slice(0, count).join(" ")) {
          cue.text = after.slice(count).join(" "); break;
        }
      }
      if (!cue.text) continue;
      previous.endTime = cue.startTime;
    }
    segments.push(cue);
  }
  const valid = segments.filter(s => s.endTime > s.startTime);
  if (!valid.length) throw new Error("YouTube 字幕文件没有有效内容");
  return valid;
}
