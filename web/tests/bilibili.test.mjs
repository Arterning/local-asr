import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../bilibili.js", import.meta.url), "utf8");
const { parseSubtitle, discoverTracks, downloadTrack } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("preserves exact timestamps, sorts cues and ignores invalid rows", () => {
  assert.deepEqual(parseSubtitle({ body: [
    { from: 4.125, to: 8.75, content: "后一句" },
    { from: 0, to: 1.3, content: "前一句" },
    { from: 3, to: 2, content: "invalid" },
    { from: -1, to: 2, content: "invalid" },
    { from: 1, to: 2, content: " " },
  ] }), [
    { startTime: 0, endTime: 1.3, text: "前一句" },
    { startTime: 4.125, endTime: 8.75, text: "后一句" },
  ]);
  assert.throws(() => parseSubtitle({ body: [] }), /没有有效内容/);
});

test("discovery uses the current part and browser login, reports login failures", async () => {
  globalThis.location = { href: "https://www.bilibili.com/video/BV1234567890?p=2" };
  globalThis.chrome = { scripting: { executeScript: async options => {
    assert.equal(options.world, "MAIN");
    return [{ result: await options.func() }];
  } } };
  let loginRequired = false;
  globalThis.fetch = async (address, options) => {
    const url = new URL(address);
    assert.equal(options.credentials, "include");
    if (url.pathname.includes("web-interface/view")) return { ok: true, json: async () => ({ code: 0, data: {
      title: "测试视频", pages: [{ page: 1, cid: 101 }, { page: 2, cid: 202, part: "第二集" }],
    } }) };
    assert.equal(url.searchParams.get("cid"), "202");
    return { ok: true, json: async () => ({ code: 0, data: loginRequired ? { need_login_subtitle: true } : {
      subtitle: { subtitles: [{ id_str: "12345678901234567890", lan: "zh-CN", lan_doc: "中文", subtitle_url: "//aisubtitle.hdslb.com/test.json" }] },
    } }) };
  };
  const info = await discoverTracks(1);
  assert.equal(info.key, "BV1234567890:2");
  assert.equal(info.tracks[0].id, "12345678901234567890");
  loginRequired = true;
  await assert.rejects(discoverTracks(1), /需要登录/);
});

test("downloads only HTTPS Bilibili subtitle hosts without credentials", async () => {
  let called = false;
  globalThis.fetch = async (url, options) => {
    called = true;
    assert.equal(url, "https://aisubtitle.hdslb.com/test.json");
    assert.equal(options.credentials, "omit");
    return { ok: true, json: async () => ({ body: [{ from: 0, to: 2, content: "字幕" }] }) };
  };
  await assert.rejects(downloadTrack({ url: "https://hdslb.com.evil.example/test" }), /不受支持/);
  await assert.rejects(downloadTrack({ url: "http://aisubtitle.hdslb.com/test" }), /不受支持/);
  assert.equal(called, false);
  assert.equal((await downloadTrack({ url: "//aisubtitle.hdslb.com/test.json" }))[0].text, "字幕");
});

test("overlay follows seeking, clears gaps and stops on part changes", async () => {
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, { textContent: "", style: {}, classList: {
      add() {}, remove() {}, toggle() {},
    } });
    return nodes.get(key);
  };
  let listener;
  const intervals = [];
  const messages = [];
  const video = { currentTime: 0, clientWidth: 800, clientHeight: 450 };
  const root = { appendChild(host) { host.parentNode = root; host.isConnected = true; } };
  const page = { pathname: "/video/BV1234567890", href: "https://www.bilibili.com/video/BV1234567890" };
  const context = vm.createContext({
    URL, location: page, setInterval: fn => intervals.push(fn), clearTimeout() {}, setTimeout() {},
    document: { documentElement: root, addEventListener() {}, querySelectorAll: () => [video],
      createElement: () => ({ attachShadow() { this.shadowRoot = { querySelector: node }; return this.shadowRoot; } }),
    },
    chrome: {
      storage: { local: { get: async settings => settings } },
      runtime: { onMessage: { addListener(fn) { listener = fn; } },
        sendMessage(message) { messages.push(message); return message.type === "GET_STATE" ? new Promise(() => {}) : Promise.resolve(); },
      },
    },
  });
  vm.runInContext(await readFile(new URL("../content/subtitle.js", import.meta.url), "utf8"), context);
  listener({ type: "NATIVE_SUBTITLES", key: "BV1234567890:1", segments: [
    { startTime: 0, endTime: 2, text: "第一句" }, { startTime: 4, endTime: 8, text: "第二句" },
  ] }, {}, () => {});
  const tick = intervals[1];
  assert.equal(node(".final").textContent, "第一句");
  video.currentTime = 5; tick();
  assert.equal(node(".final").textContent, "第二句");
  video.currentTime = 3; tick();
  assert.equal(node(".final").textContent, "");
  video.currentTime = 1; tick();
  assert.equal(node(".final").textContent, "第一句");
  page.href += "?p=2"; tick();
  assert.equal(node(".final").textContent, "");
  assert.ok(messages.some(message => message.type === "NATIVE_VIDEO_CHANGED"));
});
