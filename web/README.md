# Live Video Subtitle Extension

Chrome/Edge Manifest V3 extension that captures audio from the active YouTube
or Bilibili tab, sends 16 kHz PCM16 audio to the local FastAPI WebSocket, and
shows recognition results over the video.

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
