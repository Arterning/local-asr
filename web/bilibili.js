// Runs in the site's MAIN world so requests use the user's existing login.
export async function discoverTracks(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: async () => {
      try {
        const url = new URL(location.href);
        const bvid = url.pathname.match(/\/video\/(BV[\w]+)/i)?.[1];
        if (!bvid) throw new Error("请打开 B 站 BV 视频页面");
        const request = async (path, params) => {
          const response = await fetch(`https://api.bilibili.com${path}?${new URLSearchParams(params)}`, {
            credentials: "include", signal: AbortSignal.timeout(12000),
          });
          if (!response.ok) throw new Error(`B 站请求失败（HTTP ${response.status}）`);
          const json = await response.json();
          if (json.code !== 0) throw new Error(`B 站接口返回：${json.message || json.code}`);
          return json.data;
        };
        const info = await request("/x/web-interface/view", { bvid });
        const page = info.pages.find(item => item.page === Number(url.searchParams.get("p") || 1));
        if (!page) throw new Error("无法确定当前分 P");
        const data = await request("/x/player/wbi/v2", { bvid, cid: page.cid });
        const tracks = (data.subtitle?.subtitles || []).filter(t => t.subtitle_url && t.lan).map(t => ({
          id: String(t.id_str || t.id), language: t.lan, label: t.lan_doc || t.lan, url: t.subtitle_url,
        }));
        if (!tracks.length) throw new Error(data.need_login_subtitle
          ? "此字幕需要登录，请登录 B 站后重试"
          : "当前分 P 没有可读取的字幕轨；若播放器有字幕，请登录 B 站后重试，也可切换本地语音识别");
        return { tracks, key: `${bvid}:${page.page}`, title: `${info.title}${info.pages.length > 1 ? ` · P${page.page} ${page.part}` : ""}`, url: location.href };
      } catch (error) { return { error: error.name === "TimeoutError" ? "B 站请求超时，请重试" : error.message }; }
    },
  });
  if (!result?.result || result.result.error) throw new Error(result?.result?.error || "无法读取视频，请刷新页面后重试");
  return result.result;
}

export function parseSubtitle(json) {
  const segments = (Array.isArray(json.body) ? json.body : []).filter(row =>
    typeof row.content === "string" && row.content.trim() && Number.isFinite(row.from)
    && Number.isFinite(row.to) && row.from >= 0 && row.to > row.from,
  ).map(row => ({ text: row.content, startTime: row.from, endTime: row.to }));
  if (!segments.length) throw new Error("字幕文件没有有效内容");
  return segments.sort((a, b) => a.startTime - b.startTime);
}

export async function downloadTrack(track) {
  const url = new URL(track.url, "https://www.bilibili.com");
  if (url.protocol !== "https:" || !/(^|\.)(hdslb\.com|bilibili\.com)$/.test(url.hostname)) {
    throw new Error("字幕文件地址不受支持");
  }
  const response = await fetch(url.href, { credentials: "omit", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`字幕下载失败（HTTP ${response.status}），请重试`);
  return parseSubtitle(await response.json());
}
