/* Own video recorder (WebCodecs + mp4-muxer).
   Safari's built-in MediaRecorder sometimes stops writing the picture after ~10-12 seconds while the
   sound keeps going (a known iOS 26 MP4 bug family). This recorder skips MediaRecorder completely:
   camera frames go to the phone's H.264 encoder, the microphone goes to the AAC encoder, and
   mp4-muxer writes a normal, seekable MP4 with a correct length. If the phone does not support the
   needed pieces, liveRecorder.js falls back to MediaRecorder. */

const WC = {
  on: false, t0: 0, W: 0, H: 0, canvas: null, ctx: null,
  venc: null, aenc: null, muxer: null, target: null,
  audioCtx: null, audioNode: null, audioSrc: null, audioMute: null, audioSamples: 0, audioOffsetUs: null, sampleRate: 48000,
  frames: 0, dropped: 0, vOut: 0, aOut: 0, lastTs: -1, lastVideoOutAt: 0, pending: null, firstAudio: true, firstVideo: true,
  error: '', info: '',
};

function wcSupported() {
  return Boolean(window.VideoEncoder && window.VideoFrame && window.AudioEncoder && window.AudioData
    && window.Mp4Muxer && (window.AudioContext || window.webkitAudioContext));
}

const WC_AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// AAC-LC "AudioSpecificConfig" (2 bytes). Safari's AudioEncoder reports wrong bytes, so build it ourselves.
function wcAacConfig(sampleRate, channels) {
  let idx = WC_AAC_RATES.indexOf(sampleRate);
  if (idx < 0) idx = 3;
  const v = (2 << 11) | (idx << 7) | (channels << 3);
  return new Uint8Array([(v >> 8) & 255, v & 255]);
}

const WC_WORKLET_SRC = `
class PtiCap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.pos = 0; }
  process(inputs) {
    const c = inputs[0] && inputs[0][0];
    if (c) {
      for (let i = 0; i < c.length; i++) {
        this.buf[this.pos++] = c[i];
        if (this.pos === 1024) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(1024); this.pos = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pti-cap', PtiCap);
`;

function wcEven(n) { return Math.max(2, Math.round(n / 2) * 2); }

// Must be called straight from the Record tap (before any await) so iOS lets the audio start.
function wcPrepareAudioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = (typeof sharedAudioCtx !== 'undefined' && sharedAudioCtx) || new AC();
  try { sharedAudioCtx = ctx; } catch (e) { /* ignore */ }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  WC.audioCtx = ctx;
  return ctx;
}

function wcOnAudioSamples(f32) {
  if (!WC.on || !WC.aenc || WC.aenc.state !== 'configured') return;
  if (WC.audioOffsetUs === null) {
    const durUs = (f32.length / WC.sampleRate) * 1e6;
    WC.audioOffsetUs = Math.max(0, (performance.now() - WC.t0) * 1000 - durUs);
  }
  const ts = Math.round(WC.audioOffsetUs + (WC.audioSamples / WC.sampleRate) * 1e6);
  WC.audioSamples += f32.length;
  try {
    const ad = new AudioData({ format: 'f32-planar', sampleRate: WC.sampleRate, numberOfFrames: f32.length, numberOfChannels: 1, timestamp: ts, data: f32 });
    WC.aenc.encode(ad);
    ad.close();
  } catch (e) { WC.error = 'audio: ' + e.message; }
}

async function wcStartAudio(stream) {
  const ctx = WC.audioCtx;
  WC.sampleRate = ctx.sampleRate;
  const tracks = stream.getAudioTracks();
  if (!tracks.length) throw new Error('no microphone');
  WC.audioSrc = ctx.createMediaStreamSource(new MediaStream(tracks));
  WC.audioMute = ctx.createGain();
  WC.audioMute.gain.value = 0;
  WC.audioMute.connect(ctx.destination);
  if (ctx.audioWorklet && window.AudioWorkletNode) {
    if (!WC.workletReady || WC.workletCtx !== ctx) {
      const url = URL.createObjectURL(new Blob([WC_WORKLET_SRC], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      WC.workletReady = true;
      WC.workletCtx = ctx;
    }
    WC.audioNode = new AudioWorkletNode(ctx, 'pti-cap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    WC.audioNode.port.onmessage = (e) => wcOnAudioSamples(new Float32Array(e.data));
    WC.audioSrc.connect(WC.audioNode);
    WC.audioNode.connect(WC.audioMute);
    WC.info += ' audio=worklet';
  } else {
    WC.audioNode = ctx.createScriptProcessor(2048, 1, 1);
    WC.audioNode.onaudioprocess = (e) => wcOnAudioSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
    WC.audioSrc.connect(WC.audioNode);
    WC.audioNode.connect(WC.audioMute);
    WC.info += ' audio=scriptprocessor';
  }
}

function wcStopAudio() {
  try { if (WC.audioNode) { if (WC.audioNode.port) WC.audioNode.port.onmessage = null; WC.audioNode.disconnect(); } } catch (e) { /* ignore */ }
  try { if (WC.audioSrc) WC.audioSrc.disconnect(); } catch (e) { /* ignore */ }
  try { if (WC.audioMute) WC.audioMute.disconnect(); } catch (e) { /* ignore */ }
  WC.audioNode = null; WC.audioSrc = null; WC.audioMute = null;
}

function wcWriteVideo(item, durationUs) {
  try {
    WC.muxer.addVideoChunkRaw(item.bytes, item.type, item.ts, Math.max(1, durationUs), item.meta);
  } catch (e) { WC.error = 'mux video: ' + e.message; }
}

function wcOnVideoOutput(chunk, meta) {
  const bytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(bytes);
  WC.vOut++;
  WC.lastVideoOutAt = performance.now();
  const item = { bytes, type: chunk.type, ts: chunk.timestamp, meta: WC.firstVideo ? meta : undefined };
  WC.firstVideo = false;
  // each frame lasts until the next one starts
  if (WC.pending) wcWriteVideo(WC.pending, item.ts - WC.pending.ts);
  WC.pending = item;
}

function wcOnAudioOutput(chunk) {
  const bytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(bytes);
  WC.aOut++;
  let meta;
  if (WC.firstAudio) {
    meta = { decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 1, sampleRate: WC.sampleRate, description: wcAacConfig(WC.sampleRate, 1) } };
    WC.firstAudio = false;
  }
  try {
    WC.muxer.addAudioChunkRaw(bytes, chunk.type, chunk.timestamp, chunk.duration || Math.round((1024 / WC.sampleRate) * 1e6), meta);
  } catch (e) { WC.error = 'mux audio: ' + e.message; }
}

// Starts everything. Returns { ok: true, info } or { ok: false, reason }.
async function wcBegin(video, stream, canvas) {
  Object.assign(WC, { on: false, frames: 0, dropped: 0, vOut: 0, aOut: 0, lastTs: -1, pending: null, firstAudio: true, firstVideo: true,
    error: '', info: '', audioSamples: 0, audioOffsetUs: null });
  try {
    if (!wcSupported()) return { ok: false, reason: 'this phone does not support the new recorder' };
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return { ok: false, reason: 'no camera picture yet' };
    const k = Math.min(1, Math.sqrt(2100000 / (vw * vh)));
    WC.W = wcEven(vw * k);
    WC.H = wcEven(vh * k);
    WC.canvas = canvas;
    canvas.width = WC.W;
    canvas.height = WC.H;
    WC.ctx = canvas.getContext('2d', { alpha: false });

    let vcfg = null;
    for (const codec of ['avc1.64002a', 'avc1.640028', 'avc1.4d002a', 'avc1.42002a']) {
      const cfg = { codec, width: WC.W, height: WC.H, bitrate: LIVE_VIDEO_BPS, framerate: 30, latencyMode: 'realtime', avc: { format: 'avc' } };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r && r.supported) { vcfg = cfg; break; }
      } catch (e) { /* try next */ }
    }
    if (!vcfg) return { ok: false, reason: 'H.264 encoder not available' };

    const ctx = WC.audioCtx;
    if (!ctx) return { ok: false, reason: 'audio not ready' };
    const acfg = { codec: 'mp4a.40.2', sampleRate: ctx.sampleRate, numberOfChannels: 1, bitrate: LIVE_AUDIO_BPS };
    let asup = null;
    try { asup = await AudioEncoder.isConfigSupported(acfg); } catch (e) { asup = null; }
    if (!asup || !asup.supported) return { ok: false, reason: 'AAC encoder not available' };

    WC.target = new Mp4Muxer.ArrayBufferTarget();
    WC.muxer = new Mp4Muxer.Muxer({
      target: WC.target,
      video: { codec: 'avc', width: WC.W, height: WC.H },
      audio: { codec: 'aac', numberOfChannels: 1, sampleRate: ctx.sampleRate },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'cross-track-offset',
    });
    WC.venc = new VideoEncoder({ output: wcOnVideoOutput, error: (e) => { WC.error = 'video encoder: ' + e.message; } });
    WC.venc.configure(vcfg);
    WC.aenc = new AudioEncoder({ output: wcOnAudioOutput, error: (e) => { WC.error = 'audio encoder: ' + e.message; } });
    WC.aenc.configure(acfg);
    WC.t0 = performance.now();
    WC.lastVideoOutAt = WC.t0;
    WC.info = `${vcfg.codec} ${WC.W}x${WC.H} @6Mbps + AAC ${ctx.sampleRate}Hz`;
    WC.on = true;
    await wcStartAudio(stream);
    return { ok: true, info: WC.info };
  } catch (err) {
    WC.on = false;
    wcAbort();
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

// Called for every camera frame while recording.
function wcOnFrame(video, nowMs) {
  if (!WC.on || !WC.venc || WC.venc.state !== 'configured') return;
  if (WC.venc.encodeQueueSize > 8) { WC.dropped++; return; }
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const W = WC.W, H = WC.H;
  // The encoder size is fixed. If the camera picture changes shape, it is centred (never stretched).
  const s = Math.min(W / vw, H / vh);
  const w = vw * s, h = vh * s;
  if (Math.abs(w - W) > 2 || Math.abs(h - H) > 2) {
    WC.ctx.fillStyle = '#000';
    WC.ctx.fillRect(0, 0, W, H);
    WC.ctx.drawImage(video, (W - w) / 2, (H - h) / 2, w, h);
  } else {
    WC.ctx.drawImage(video, 0, 0, W, H);
  }
  let ts = Math.round((nowMs - WC.t0) * 1000);
  if (ts <= WC.lastTs) ts = WC.lastTs + 1;
  WC.lastTs = ts;
  try {
    const frame = new VideoFrame(WC.canvas, { timestamp: ts });
    WC.venc.encode(frame, { keyFrame: WC.frames % 60 === 0 });
    frame.close();
    WC.frames++;
  } catch (e) { WC.error = 'frame: ' + e.message; }
}

function wcAbort() {
  WC.on = false;
  wcStopAudio();
  try { if (WC.venc && WC.venc.state !== 'closed') WC.venc.close(); } catch (e) { /* ignore */ }
  try { if (WC.aenc && WC.aenc.state !== 'closed') WC.aenc.close(); } catch (e) { /* ignore */ }
  WC.venc = null; WC.aenc = null; WC.muxer = null; WC.target = null; WC.pending = null;
}

const wcWithTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(res, ms))]);

// Stops recording and returns the finished MP4 file.
async function wcFinish() {
  WC.on = false;
  wcStopAudio();
  try { await wcWithTimeout(WC.venc.flush(), 8000); } catch (e) { WC.error = 'flush video: ' + e.message; }
  try { await wcWithTimeout(WC.aenc.flush(), 4000); } catch (e) { WC.error = 'flush audio: ' + e.message; }
  if (WC.pending) { wcWriteVideo(WC.pending, 33333); WC.pending = null; }
  const stats = `encoded ${WC.frames} frames, dropped ${WC.dropped}, video chunks ${WC.vOut}, audio chunks ${WC.aOut}${WC.error ? ', problem: ' + WC.error : ''}`;
  let blob = null;
  try {
    WC.muxer.finalize();
    blob = new Blob([WC.target.buffer], { type: 'video/mp4' });
  } catch (e) {
    WC.error = 'finalize: ' + e.message;
  }
  try { if (WC.venc && WC.venc.state !== 'closed') WC.venc.close(); } catch (e) { /* ignore */ }
  try { if (WC.aenc && WC.aenc.state !== 'closed') WC.aenc.close(); } catch (e) { /* ignore */ }
  WC.venc = null; WC.aenc = null; WC.muxer = null; WC.target = null;
  return { blob, stats };
}
