import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../youtube.js", import.meta.url), "utf8");
const { parseSubtitle, discoverTracks, downloadTrack } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const fixture = { events: [{ tStartMs: 125, dDurationMs: 2000, segs: [{ utf8: "Hello " }, { utf8: "world" }] }] };

test("manual captions retain timing, repeated speech and overlapping cues", () => {
  assert.deepEqual(parseSubtitle(fixture), [{ text: "Hello world", startTime: .125, endTime: 2.125 }]);
  const event = { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: "yes" }] };
  assert.equal(parseSubtitle({ events: [event, { ...event, tStartMs: 2000 }] }).length, 2);
  assert.throws(() => parseSubtitle({ events: [{ tStartMs: -1, dDurationMs: 1000, segs: [{ utf8: "bad" }] }] }), /没有有效内容/);
});

test("automatic captions merge append events and remove only overlapping roll-up repetitions", () => {
  const event = (start, text, extra = {}) => ({ tStartMs: start, dDurationMs: 3000, segs: [{ utf8: text }], ...extra });
  assert.deepEqual(parseSubtitle({ events: [
    event(0, "Hello"), event(500, " world", { aAppend: 1 }),
    event(2000, "Hello world again"), event(6000, "Hello world again"),
  ] }, true), [
    { text: "Hello world", startTime: 0, endTime: 2 },
    { text: "again", startTime: 2, endTime: 5 },
    { text: "Hello world again", startTime: 6, endTime: 9 },
  ]);
  assert.deepEqual(parseSubtitle({ events: [event(0, "Hello world"), event(0, "Hello world again")] }, true),
    [{ text: "Hello world again", startTime: 0, endTime: 3 }]);
});

function pageHarness({ stale = false, noTracks = false, live = false, blocked = false, capture = false, timeout = false } = {}) {
  const calls = [];
  const tracks = noTracks ? [] : [
    { vssId: ".en", languageCode: "en", name: { simpleText: "English" }, baseUrl: "https://www.youtube.com/api/timedtext?v=testVideo01&lang=en" },
    { vssId: "a.en", languageCode: "en", kind: "asr", name: { runs: [{ text: "English" }] }, baseUrl: "https://www.youtube.com/api/timedtext?v=testVideo01&lang=en&kind=asr" },
  ];
  const playerResponse = { videoDetails: { videoId: stale ? "previousVideo" : "testVideo01", title: "Test", isLive: live },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } };
  const originalTrack = { languageCode: "fr" };
  const player = { getPlayerResponse: () => playerResponse, getOption: () => originalTrack,
    loadModule() { calls.push("load"); }, unloadModule() { calls.push("unload"); },
    setOption(module, option, track) {
      calls.push(track);
      if (track.languageCode === "en" && capture) context.fetch("https://www.youtube.com/api/timedtext?v=testVideo01&lang=en&pot=player-token");
    },
  };
  const network = async address => {
    calls.push(String(address));
    const ok = !blocked || String(address).includes("pot=player-token");
    return { ok, status: ok ? 200 : 403, text: async () => ok ? JSON.stringify(fixture) : "",
      clone() { return this; } };
  };
  class XHR { open() {} }
  const context = vm.createContext({
    URL, AbortSignal, XMLHttpRequest: XHR, fetch: network,
    location: { href: "https://www.youtube.com/watch?v=testVideo01", origin: "https://www.youtube.com" },
    performance: { getEntriesByType: () => [] },
    setTimeout: timeout ? fn => setTimeout(fn, 1) : setTimeout, clearTimeout,
    document: { title: "Test", querySelector: selector => selector === "#movie_player" ? player : { getAttribute: () => "true" } },
  });
  context.window = context;
  context.ytInitialPlayerResponse = playerResponse;
  globalThis.chrome = { scripting: { executeScript: async ({ func, args, world }) => {
    assert.equal(world, "MAIN");
    context.args = args;
    return [{ result: await vm.runInContext(`(${func.toString()})(...args)`, context) }];
  } } };
  return { calls, context, network, originalTrack, XHR, originalOpen: XHR.prototype.open };
}

test("discovers manual and automatic tracks and downloads in the page", async () => {
  const { calls } = pageHarness();
  const info = await discoverTracks(1);
  assert.equal(info.key, "youtube:testVideo01");
  assert.equal(info.tracks[0].automatic, false);
  assert.match(info.tracks[1].label, /自动生成/);
  assert.equal((await downloadTrack(info.tracks[0], 1))[0].text, "Hello world");
  assert.ok(calls.some(call => typeof call === "string" && call.includes("fmt=json3")));
});

test("rejects stale player responses, missing captions and live videos", async () => {
  pageHarness({ stale: true }); await assert.rejects(discoverTracks(1), /尚未加载/);
  pageHarness({ noTracks: true }); await assert.rejects(discoverTracks(1), /没有可读取/);
  pageHarness({ live: true }); await assert.rejects(discoverTracks(1), /直播/);
});

test("captures a validated player response and restores hooks and caption settings", async () => {
  const { context, calls, network, originalTrack, XHR, originalOpen } = pageHarness({ blocked: true, capture: true });
  const info = await discoverTracks(1);
  assert.equal((await downloadTrack(info.tracks[0], 1))[0].text, "Hello world");
  assert.equal(context.fetch, network);
  assert.equal(XHR.prototype.open, originalOpen);
  assert.equal(calls.at(-1), originalTrack);
});

test("timeout restores hooks and returns an actionable error", async () => {
  const { context, network, XHR, originalOpen } = pageHarness({ blocked: true, timeout: true });
  const info = await discoverTracks(1);
  await assert.rejects(downloadTrack(info.tracks[0], 1), /CC 字幕/);
  assert.equal(context.fetch, network);
  assert.equal(XHR.prototype.open, originalOpen);
});

test("a selected track cannot be downloaded on a different video", async () => {
  pageHarness();
  const info = await discoverTracks(1);
  await assert.rejects(downloadTrack({ ...info.tracks[0], videoId: "anotherVideo" }, 1), /视频已切换/);
});
