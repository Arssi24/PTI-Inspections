/* Rebuilds a MediaRecorder MP4 into a normal, seekable MP4.
   Safari's MediaRecorder writes a fragmented MP4 with no real duration/seek index, which is
   what made videos stop after a few seconds and refuse to scrub. This re-reads the
   already-encoded frames (no re-encoding, so no quality loss) and writes them out again with a
   proper index at the front of the file. */

function mp4DescriptionFromBox(box) {
  const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  box.write(ds);
  return new Uint8Array(ds.buffer.slice(8, ds.position));
}

const REPAIR_STATS = {};

// Finds key frames by reading the video data itself (H.264 IDR / H.265 IRAP NAL units) instead
// of trusting the recorder's flags. A file with no marked key frame shows black video.
function isKeyFrameData(data, lenSize, hevc) {
  let p = 0;
  const n = data.length;
  while (p + lenSize <= n) {
    let len = 0;
    for (let i = 0; i < lenSize; i++) len = (len * 256) + data[p + i];
    p += lenSize;
    if (len <= 0 || p + len > n) break;
    if (hevc) {
      const t = (data[p] >> 1) & 0x3f;
      if (t >= 16 && t <= 21) return true;
    } else if ((data[p] & 0x1f) === 5) {
      return true;
    }
    p += len;
  }
  return false;
}

function nalTypesOf(data, lenSize, hevc) {
  const out = [];
  let p = 0;
  const n = data.length;
  while (p + lenSize <= n && out.length < 6) {
    let len = 0;
    for (let i = 0; i < lenSize; i++) len = (len * 256) + data[p + i];
    p += lenSize;
    if (len <= 0 || p + len > n) break;
    out.push(hevc ? (data[p] >> 1) & 0x3f : data[p] & 0x1f);
    p += len;
  }
  return out.join(',');
}

async function repairMp4(blob, opts = {}) {
  if (typeof MP4Box === 'undefined' || typeof Mp4Muxer === 'undefined') throw new Error('repair libs missing');
  const buf = await blob.arrayBuffer();
  buf.fileStart = 0;

  const file = MP4Box.createFile();
  const tracks = {};
  let infoTracks = null;
  await new Promise((resolve, reject) => {
    file.onError = (e) => reject(new Error('mp4 parse error: ' + e));
    file.onReady = (info) => {
      infoTracks = info.tracks.filter((t) => t.video || t.audio);
      infoTracks.forEach((t) => {
        tracks[t.id] = { info: t, samples: [] };
        file.setExtractionOptions(t.id, null, { nbSamples: 500 });
      });
      file.start();
    };
    file.onSamples = (id, user, samples) => {
      for (const s of samples) tracks[id].samples.push(s);
    };
    file.appendBuffer(buf);
    file.flush();
    setTimeout(resolve, 0);
  });

  const vTrack = infoTracks && infoTracks.find((t) => t.video);
  if (!vTrack || tracks[vTrack.id].samples.length === 0) throw new Error('no video samples');
  const aTrack = opts.noAudio ? null : infoTracks.find((t) => t.audio);

  const trakOf = (id) => file.moov.traks.find((t) => t.tkhd.track_id === id);
  const vEntry = trakOf(vTrack.id).mdia.minf.stbl.stsd.entries[0];
  const vCodec = /^(hvc1|hev1)/.test(vTrack.codec) ? 'hevc' : 'avc';
  const vBox = vCodec === 'hevc' ? vEntry.hvcC : vEntry.avcC;
  if (!vBox) throw new Error('no video codec config');
  const vDescription = mp4DescriptionFromBox(vBox);

  const options = {
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: vCodec, width: vTrack.video.width, height: vTrack.video.height },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'cross-track-offset',
  };
  let aDescription = null;
  if (aTrack) {
    const aEntry = trakOf(aTrack.id).mdia.minf.stbl.stsd.entries[0];
    try {
      aDescription = new Uint8Array(aEntry.esds.esd.descs[0].descs[0].data);
      options.audio = { codec: 'aac', numberOfChannels: aTrack.audio.channel_count, sampleRate: aTrack.audio.sample_rate };
    } catch (e) {
      aDescription = null; // unreadable audio config: keep the video, drop the audio rather than fail
    }
  }

  const muxer = new Mp4Muxer.Muxer(options);
  const us = (v, ts) => Math.max(0, Math.round((v * 1e6) / ts));

  const vSamples = tracks[vTrack.id].samples;
  const lenSize = ((vBox.lengthSizeMinusOne != null ? vBox.lengthSizeMinusOne : 3) & 3) + 1;
  let keyFlagged = 0;
  let keyDetected = 0;
  let keyUsed = 0;
  const keyMode = opts.keyMode || 'idr';
  const flaggedNotes = [];
  vSamples.forEach((s, i) => {
    const meta = i === 0
      ? { decoderConfig: { codec: vTrack.codec, codedWidth: vTrack.video.width, codedHeight: vTrack.video.height, description: vDescription } }
      : undefined;
    const pts = us(s.cts, s.timescale);
    const dts = us(s.dts, s.timescale);
    const bytes = new Uint8Array(s.data);
    const detected = isKeyFrameData(bytes, lenSize, vCodec === 'hevc');
    if (s.is_sync) keyFlagged++;
    if (detected) keyDetected++;
    // Only real keyframes (IDR) are marked as sync points. The recorder's own flags marked
    // ordinary frames as keyframes, which makes Safari reset its decoder and freeze the picture.
    const isKey = i === 0 || (keyMode === 'flagged' ? (s.is_sync || detected) : detected);
    if (isKey) keyUsed++;
    if (s.is_sync && flaggedNotes.length < 8) flaggedNotes.push(`#${i}:nal[${nalTypesOf(bytes, lenSize, vCodec === 'hevc')}]`);
    muxer.addVideoChunkRaw(bytes, isKey ? 'key' : 'delta', pts, us(s.duration, s.timescale), meta, pts - dts);
  });
  if (!opts.noAudio && !opts.keyMode) {
    REPAIR_STATS.video = `video samples=${vSamples.length} keyFlagged=${keyFlagged} keyDetected=${keyDetected} keyUsed=${keyUsed} lenSize=${lenSize} firstDts=${vSamples[0].dts} ts=${vSamples[0].timescale}\nflagged samples: ${flaggedNotes.join(' ')} (nal 5 = real keyframe)`;
  }

  if (aTrack && aDescription) {
    const aSamples = tracks[aTrack.id].samples;
    aSamples.forEach((s, i) => {
      const meta = i === 0
        ? { decoderConfig: { codec: aTrack.codec, numberOfChannels: aTrack.audio.channel_count, sampleRate: aTrack.audio.sample_rate, description: aDescription } }
        : undefined;
      muxer.addAudioChunkRaw(new Uint8Array(s.data), 'key', us(s.cts, s.timescale), us(s.duration, s.timescale), meta);
    });
  }

  muxer.finalize();
  return new Blob([options.target.buffer], { type: 'video/mp4' });
}

// One-line summary of an MP4's structure, for the on-screen "Recording details" panel.
async function describeMp4(blob) {
  try {
    const buf = await blob.arrayBuffer();
    buf.fileStart = 0;
    const u8 = new Uint8Array(buf);
    const boxes = [];
    for (let p = 0; p + 8 <= u8.length && boxes.length < 14;) {
      const sz = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
      boxes.push(String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]));
      if (sz < 8) break;
      p += sz;
    }
    const f = MP4Box.createFile();
    const info = await new Promise((res, rej) => {
      f.onReady = res;
      f.onError = rej;
      f.appendBuffer(buf);
      f.flush();
      setTimeout(() => rej(new Error('no moov found')), 4000);
    });
    const tracks = info.tracks.map((t) => `${t.video ? 'video' : 'audio'} ${t.codec} ${t.video ? t.video.width + 'x' + t.video.height : ''} samples=${t.nb_samples} dur=${(t.duration / t.timescale).toFixed(1)}s`);
    return `fragmented=${info.isFragmented} total=${(info.duration / info.timescale).toFixed(1)}s\n${tracks.join('\n')}\nboxes: ${boxes.join(' ')}`;
  } catch (e) {
    return 'could not read: ' + e.message;
  }
}

// Plays a blob briefly and measures whether a real picture (not black) was drawn. Diagnostic only.
function measureFrameBrightness(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    const url = URL.createObjectURL(blob);
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(url);
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
      resolve(result);
    };
    const sample = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 32;
        c.height = 18;
        const ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, 32, 18);
        const d = ctx.getImageData(0, 0, 32, 18).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        finish(`brightness=${(sum / (d.length / 4)).toFixed(0)}/255 at ${v.currentTime.toFixed(1)}s (0 means black picture)`);
      } catch (e) {
        finish('could not read picture: ' + e.message);
      }
    };
    setTimeout(() => finish('picture check timed out'), 6000);
    v.addEventListener('error', () => finish('picture check: player error'));
    v.addEventListener('loadeddata', () => {
      v.play().then(() => {
        setTimeout(sample, 700);
      }).catch(() => sample());
    });
    v.src = url;
  });
}

// Confirms the file really plays and seeks, since that's the exact thing that used to break.
function verifyPlayable(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    const url = URL.createObjectURL(blob);
    const done = (ok, info) => { URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve({ ok, ...info }); };
    v.playsInline = true;
    const timer = setTimeout(() => done(false, { reason: 'timeout' }), 12000);
    v.addEventListener('error', () => { clearTimeout(timer); done(false, { reason: 'error' }); });
    v.addEventListener('loadedmetadata', () => {
      if (!Number.isFinite(v.duration) || v.duration <= 0) { clearTimeout(timer); done(false, { reason: 'no-duration' }); return; }
      const target = v.duration / 2;
      v.addEventListener('seeked', () => {
        clearTimeout(timer);
        done(Math.abs(v.currentTime - target) < 1.5, { duration: v.duration, width: v.videoWidth, height: v.videoHeight });
      }, { once: true });
      v.currentTime = target;
    });
    v.src = url;
  });
}
