# Live Video Subtitle Extension

## B 站字幕轨

在 B 站 BV 视频页面打开插件，选择 **B 站视频字幕**，点击 **读取视频字幕**。
此模式使用浏览器已有的 B 站登录状态，无需启动本地 ASR 服务，不采集音频。
读取成功后，插件会保存当前分 P 的整份字幕，按视频播放时间显示，并支持暂停、拖动和倍速。
可以在 **字幕语言** 中切换接口提供的字幕轨；每次读取或切换语言都会保存一份独立记录。
点击 **查看全文 / 导出字幕**，在历史记录中选择相应记录，复制或导出 TXT、SRT、WebVTT、JSON。
字幕轨导出保留原始时间轴。停止显示不会删除已经保存的全文。

当前支持 `/video/BV...` 普通视频及 `?p=N` 分 P；切换页面或分 P 后重新点击读取。
不支持从视频画面提取硬字幕。没有字幕、未登录或接口失败时会显示提示，可手动切换到
**本地语音识别**。B 站接口可能变化；播放器可用并不保证接口请求始终成功。
插件悬浮字幕与 B 站播放器字幕独立，如显示重复可关闭播放器自身的字幕。

更新插件后，在扩展管理页重新加载 `web`，并刷新视频页面。
新增权限用于在 B 站页面查询字幕轨和下载 B 站字幕 CDN 文件，不读取或保存 Cookie 字符串。

验证：`node --test web/tests/*.test.mjs`（从仓库根目录执行）。
浏览器验收：登录后读取有字幕的视频；切换语言；暂停、拖动和倍速；切换分 P；
停止后检查全文仍可导出；检查无字幕及未登录提示；切换本地识别确认原有流程。

## YouTube 字幕轨

在 YouTube 普通视频页面（`/watch?v=...`）打开插件，手动选择 **YouTube 视频字幕**，
点击 **读取视频字幕**。字幕来源保留三个独立选项：B 站视频字幕、YouTube 视频字幕、
本地语音识别；插件记住上次手动选择，不按网页自动切换来源。来源与页面不符时会提示。

支持人工字幕和自动生成字幕，语言列表会标明类型。优先选择中文人工字幕，其次其他人工字幕，
最后自动字幕；可以手动切换。完整字幕保存、导出和播放同步沿用 B 站字幕模式。
自动字幕会合并追加事件，并对时间重叠的滚动文本做保守去重，保留后续再次说出的相同内容。

实现位于 `youtube.js`，在当前 YouTube 页面中读取播放器字幕轨及字幕 JSON3/XML，
无需后端服务或额外 Python 依赖，不导出登录 Cookie。遇到字幕地址校验失败时，
会尝试短暂开启并切换播放器 CC，读取该字幕轨的实际网络响应，完成或超时后恢复播放器设置。
如果仍然失败，请先播放视频、在 YouTube 中打开目标语言的 CC 字幕，然后重新读取。
登录本身不保证能够获取；无字幕、接口校验失败和网络错误都会给出提示。

此版本不支持 Shorts、嵌入页、直播实时字幕及自动翻译；切换视频后需要重新读取。
新增 YouTube 页面权限用于语言切换等操作时在视频标签页执行字幕读取。
更新扩展后需重新加载并刷新视频页面。自动化测试使用模拟播放器与网络，
实际 YouTube 接口和账号环境仍需在浏览器中验收。

Chrome/Edge Manifest V3 extension that captures audio from the active YouTube
or Bilibili tab, sends 16 kHz PCM16 audio to the local FastAPI WebSocket, and
shows recognition results over the video.

Every finalized sentence is saved immediately in the extension's local
IndexedDB. Use **查看完整识别记录** in the popup to open the history page. It
supports transcript search, title editing, deletion, copying, and TXT, SRT,
WebVTT, or JSON downloads. Partial recognition hypotheses are never persisted,
so the saved transcript does not contain repeated intermediate text.

## Install

1. Start the backend from `../api`:

   ```powershell
   uv run uvicorn main:app --host 127.0.0.1 --port 8000
   ```

2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this `web` directory.
5. Open a YouTube or Bilibili video, click the extension, then click **开始识别**.

Chrome 116 or newer is required because the service worker passes a captured
tab stream ID to an offscreen document.

## Audio protocol

The extension sends binary WebSocket frames containing mono, 16,000 Hz,
signed 16-bit little-endian PCM. Each frame contains approximately 100 ms of
audio. Closing the popup does not stop recognition; use the popup's stop button
to end capture.

SRT and WebVTT timestamps are estimated from the video's current playback
position when each final ASR result arrives. They are suitable as a draft but
may need small timing adjustments for production subtitles.
