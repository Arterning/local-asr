import { clearHistory, deleteSession, getSegments, listSessions, updateSession } from "../storage/transcript-db.js";

const ui = {
  sessionList: document.querySelector("#sessionList"), sessionSearch: document.querySelector("#sessionSearch"),
  empty: document.querySelector("#emptyState"), detail: document.querySelector("#detail"),
  title: document.querySelector("#titleInput"), platform: document.querySelector("#platform"),
  createdAt: document.querySelector("#createdAt"), status: document.querySelector("#status"),
  source: document.querySelector("#sourceButton"), remove: document.querySelector("#deleteButton"),
  clear: document.querySelector("#clearButton"), copy: document.querySelector("#copyAllButton"),
  textSearch: document.querySelector("#textSearch"), segments: document.querySelector("#segments"),
};
let sessions = [];
let selected = null;
let segments = [];

const statusText = { recording: "识别中", completed: "已完成", interrupted: "已中断", failed: "启动失败" };
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });

function shortTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function subtitleTime(seconds, decimal = ",") {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${decimal}${String(millis).padStart(3, "0")}`;
}

function renderSessionList() {
  const query = ui.sessionSearch.value.trim().toLowerCase();
  const visible = sessions.filter((session) => session.title.toLowerCase().includes(query));
  ui.sessionList.replaceChildren(...visible.map((session) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session${selected?.id === session.id ? " active" : ""}`;
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.title;
    const meta = document.createElement("span");
    meta.className = "session-meta";
    const date = document.createElement("span");
    date.textContent = dateFormat.format(session.createdAt);
    const count = document.createElement("span");
    count.textContent = `${session.segmentCount} 段`;
    meta.append(date, count);
    button.append(title, meta);
    button.addEventListener("click", () => selectSession(session.id));
    return button;
  }));
}

function renderSegments() {
  const query = ui.textSearch.value.trim().toLowerCase();
  const visible = segments.filter((segment) => segment.text.toLowerCase().includes(query));
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "no-results";
    empty.textContent = segments.length ? "没有匹配的文字" : "这条记录还没有最终识别结果";
    ui.segments.replaceChildren(empty);
    return;
  }
  ui.segments.replaceChildren(...visible.map((segment) => {
    const row = document.createElement("div");
    row.className = "segment";
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = `${shortTime(segment.startTime)} – ${shortTime(segment.endTime)}`;
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = segment.text;
    row.append(time, text);
    return row;
  }));
}

async function selectSession(id) {
  selected = sessions.find((session) => session.id === id) || null;
  if (!selected) return;
  segments = await getSegments(id);
  ui.empty.hidden = true;
  ui.detail.hidden = false;
  ui.title.value = selected.title;
  ui.platform.textContent = selected.platform === "bilibili" ? "哔哩哔哩" : selected.platform === "youtube" ? "YouTube" : "视频";
  ui.createdAt.textContent = dateFormat.format(selected.createdAt);
  ui.status.textContent = statusText[selected.status] || selected.status;
  ui.source.disabled = !selected.url;
  renderSessionList();
  renderSegments();
}

async function refresh(preferredId = selected?.id) {
  sessions = await listSessions();
  renderSessionList();
  if (!sessions.length) {
    selected = null;
    ui.detail.hidden = true;
    ui.empty.hidden = false;
    return;
  }
  await selectSession(sessions.some((item) => item.id === preferredId) ? preferredId : sessions[0].id);
}

function exportContent(format) {
  if (format === "json") return JSON.stringify({ session: selected, segments }, null, 2);
  if (format === "srt") return segments.map((segment, index) => `${index + 1}\n${subtitleTime(segment.startTime)} --> ${subtitleTime(segment.endTime)}\n${segment.text}\n`).join("\n");
  if (format === "vtt") return `WEBVTT\n\n${segments.map((segment) => `${subtitleTime(segment.startTime, ".")} --> ${subtitleTime(segment.endTime, ".")}\n${segment.text}\n`).join("\n")}`;
  return segments.map((segment) => segment.text).join("\n");
}

function download(format) {
  if (!selected) return;
  const content = exportContent(format);
  const mime = format === "json" ? "application/json" : format === "vtt" ? "text/vtt" : "text/plain";
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const anchor = document.createElement("a");
  const safeTitle = selected.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 80) || "transcript";
  anchor.href = url;
  anchor.download = `${safeTitle}.${format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

ui.sessionSearch.addEventListener("input", renderSessionList);
ui.textSearch.addEventListener("input", renderSegments);
ui.title.addEventListener("change", async () => {
  if (!selected) return;
  const title = ui.title.value.trim() || "未命名视频";
  await updateSession(selected.id, { title });
  selected.title = title;
  const item = sessions.find((session) => session.id === selected.id);
  if (item) item.title = title;
  renderSessionList();
});
ui.source.addEventListener("click", () => { if (selected?.url) chrome.tabs.create({ url: selected.url }); });
ui.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(exportContent("txt"));
  ui.copy.textContent = "已复制";
  setTimeout(() => { ui.copy.textContent = "复制全部"; }, 1200);
});
ui.remove.addEventListener("click", async () => {
  if (!selected || !confirm(`确定删除“${selected.title}”吗？`)) return;
  await deleteSession(selected.id);
  await refresh(null);
});
ui.clear.addEventListener("click", async () => {
  if (!sessions.length || !confirm("确定清空全部识别记录吗？此操作无法撤销。")) return;
  await clearHistory();
  await refresh(null);
});
document.querySelectorAll(".download").forEach((button) => {
  button.addEventListener("click", () => download(button.dataset.format));
});

refresh();
setInterval(() => { if (selected?.status === "recording") refresh(selected.id); }, 2000);
