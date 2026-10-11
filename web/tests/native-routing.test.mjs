import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../background.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
function harness({ provider = "youtube", deferred = false } = {}) {
  const url = provider === "youtube" ? "https://www.youtube.com/watch?v=testVideo01" : "https://www.bilibili.com/video/BV1234567890";
  const saved = [];
  const calls = [];
  let release;
  const segment = { text: "test", startTime: 1, endTime: 2 };
  const adapter = name => ({
    discoverTracks: async () => { calls.push(name); return { url, key: "key", title: "Title", tracks: [{ id: "en", language: "en", label: "English" }] }; },
    downloadTrack: async () => deferred ? new Promise(resolve => { release = () => resolve([segment]); }) : [segment],
  });
  const bili = adapter("bilibili");
  const context = vm.createContext({
    console, youtube: adapter("youtube"), ...bili,
    listSessions: async () => [], updateSession: async () => {},
    importSubtitleSession: async (metadata, segments) => { saved.push({ metadata, segments }); return { id: "session-1" }; },
    chrome: {
      storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}) } },
      runtime: { sendMessage: async () => {}, onMessage: { addListener() {} } },
      tabs: { get: async () => ({ id: 1, url, title: "Title" }), sendMessage: async () => ({}),
        onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    },
  });
  vm.runInContext(source, context);
  return { saved, calls, context, release: () => release?.() };
}

test("explicit YouTube selection routes, saves source metadata and retains the provider for language changes", async () => {
  const { context, saved, calls } = harness();
  await vm.runInContext('startNative(1, null, "youtube")', context);
  assert.deepEqual(calls, ["youtube"]);
  assert.equal(saved[0].metadata.source, "youtube-subtitle");
  assert.equal(saved[0].metadata.platform, "youtube");
  assert.equal(vm.runInContext("state.provider", context), "youtube");
});

test("Bilibili routing remains available and the wrong source is rejected before stopping", async () => {
  const { context, saved, calls } = harness({ provider: "bilibili" });
  await vm.runInContext('startNative(1, null, "bilibili")', context);
  await assert.rejects(vm.runInContext('startNative(1, null, "youtube")', context), /切换字幕来源/);
  assert.deepEqual(calls, ["bilibili"]);
  assert.equal(saved[0].metadata.source, "bilibili-subtitle");
  assert.equal(vm.runInContext("state.status", context), "subtitles");
});

test("stopping a pending download does not import or restart subtitles", async () => {
  const { context, saved, release } = harness({ deferred: true });
  const pending = vm.runInContext('startNative(1, null, "youtube")', context);
  await new Promise(resolve => setImmediate(resolve));
  await vm.runInContext("stopCapture()", context);
  release();
  await pending;
  assert.equal(saved.length, 0);
  assert.equal(vm.runInContext("state.status", context), "idle");
});
