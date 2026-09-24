let mediaStream = null;
let audioContext = null;
let workletNode = null;
let websocket = null;
let keepAudio = true;
let intentionallyStopped = false;

function reportStatus(status, error = "") {
  chrome.runtime.sendMessage({ type: "OFFSCREEN_STATUS", status, error }).catch(() => {});
}

function closeResources() {
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (websocket) {
    websocket.onclose = null;
    websocket.onerror = null;
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "finish" }));
      websocket.close(1000, "capture stopped");
    } else {
      websocket.close();
    }
    websocket = null;
  }
}

function connectWebSocket(serverUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(serverUrl);
    ws.binaryType = "arraybuffer";

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("连接识别服务超时，请确认后端已启动"));
    }, 6000);

    ws.onopen = () => {
      clearTimeout(timeout);
      websocket = ws;
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("无法连接识别服务，请检查 WebSocket 地址"));
    };
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "partial" || message.type === "final") {
          chrome.runtime.sendMessage({
            type: "ASR_RESULT",
            resultType: message.type,
            text: message.text || "",
          }).catch(() => {});
        } else if (message.type === "error") {
          reportStatus("error", message.message || "识别服务发生错误");
        }
      } catch (error) {
        console.warn("Invalid ASR message", error);
      }
    };
    ws.onclose = (event) => {
      websocket = null;
      if (!intentionallyStopped) {
        intentionallyStopped = true;
        closeResources();
        intentionallyStopped = false;
        const detail = [
          `code=${event.code}`,
          event.reason ? `reason=${event.reason}` : "",
          `clean=${event.wasClean}`,
        ].filter(Boolean).join(", ");
        reportStatus("error", `识别服务连接已断开（${detail}）`);
      }
    };
  });
}

async function startCapture(message) {
  intentionallyStopped = true;
  closeResources();
  intentionallyStopped = false;
  keepAudio = message.settings.keepAudio !== false;

  await connectWebSocket(message.settings.serverUrl);

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId,
        },
      },
      video: false,
    });

    const track = mediaStream.getAudioTracks()[0];
    track.addEventListener("ended", () => {
      if (!intentionallyStopped) {
        intentionallyStopped = true;
        closeResources();
        intentionallyStopped = false;
        reportStatus("idle");
      }
    });

    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule("pcm-worklet.js");
    const source = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, "pcm16-resampler", {
      processorOptions: { targetSampleRate: 16000 },
    });

    workletNode.port.onmessage = (event) => {
      if (websocket?.readyState === WebSocket.OPEN) {
        websocket.send(event.data);
      }
    };

    source.connect(workletNode);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    workletNode.connect(silentGain).connect(audioContext.destination);
    if (keepAudio) source.connect(audioContext.destination);

    await audioContext.resume();
    reportStatus("capturing");
  } catch (error) {
    intentionallyStopped = true;
    closeResources();
    intentionallyStopped = false;
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  if (message.type === "START_CAPTURE") {
    startCapture(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        reportStatus("error", error.message || String(error));
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  if (message.type === "STOP_CAPTURE") {
    intentionallyStopped = true;
    closeResources();
    reportStatus("idle");
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "SETTINGS_CHANGED" && message.settings.keepAudio !== keepAudio) {
    // This setting takes effect on the next capture to avoid rebuilding the graph mid-stream.
    keepAudio = message.settings.keepAudio;
  }
  return false;
});
