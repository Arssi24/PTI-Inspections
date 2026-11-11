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

async function repairMp4(blob) {
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
  const aTrack = infoTracks.find((t) => t.audio);

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
  vSamples.forEach((s, i) => {
    const meta = i === 0
      ? { decoderConfig: { codec: vTrack.codec, codedWidth: vTrack.video.width, codedHeight: vTrack.video.height, description: vDescription } }
      : undefined;
    const pts = us(s.cts, s.timescale);
    const dts = us(s.dts, s.timescale);
    muxer.addVideoChunkRaw(new Uint8Array(s.data), s.is_sync ? 'key' : 'delta', pts, us(s.duration, s.timescale), meta, pts - dts);
  });

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

// Confirms the file really plays and seeks, since that's the exact thing that used to break.
function verifyPlayable(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    const url = URL.createObjectURL(blob);
    const done = (ok, info) => { URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve({ ok, ...info }); };
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
