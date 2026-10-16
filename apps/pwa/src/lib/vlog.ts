import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  CustomVideoDecoder,
  type EncodedPacket,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  type VideoCodec,
  VideoSample,
  canEncode,
  registerDecoder,
} from "mediabunny";

/**
 * Chromium の MediaRecorder は mp4 の vpcC に VP9 の level を 0 と書くため、
 * コーデック文字列が `vp09.00.00.08…` になり VideoDecoder に拒否される。
 * level を有効な値に直してネイティブの VideoDecoder に渡す。
 */
class Vp9LevelFixDecoder extends CustomVideoDecoder {
  private decoder: VideoDecoder | null = null;

  static override supports(codec: VideoCodec, config: VideoDecoderConfig) {
    return codec === "vp9" && /^vp09\.\d\d\.00\./.test(config.codec) && typeof VideoDecoder !== "undefined";
  }

  init() {
    this.decoder = new VideoDecoder({
      output: (frame) => this.onSample(new VideoSample(frame)),
      error: (e) => this.onError(e),
    });
    this.decoder.configure({ ...this.config, codec: this.config.codec.replace(/^(vp09\.\d\d)\.00\./, "$1.41.") });
  }

  decode(packet: EncodedPacket) {
    this.decoder!.decode(packet.toEncodedVideoChunk());
  }

  flush() {
    return this.decoder!.flush();
  }

  close() {
    this.decoder?.close();
  }
}
registerDecoder(Vp9LevelFixDecoder);

const WIDTH = 720;
const HEIGHT = 1280;

/** 再生時の .overlay-text と同じ見た目で、文字を中央に焼き込む */
function drawOverlayText(ctx: OffscreenCanvasRenderingContext2D, text: string) {
  const size = 56;
  ctx.save();
  ctx.font = `800 ${size}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // 幅に収まるように 1 文字ずつ折り返す（日本語は単語の区切りがないため）
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > WIDTH * 0.84 && line) {
      lines.push(line);
      line = ch;
    } else line += ch;
  }
  lines.push(line);
  const lh = size * 1.25;
  const top = HEIGHT / 2 - ((lines.length - 1) * lh) / 2;
  ctx.lineJoin = "round";
  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 12;
  lines.forEach((l, k) => {
    ctx.strokeText(l, WIDTH / 2, top + k * lh);
    ctx.fillText(l, WIDTH / 2, top + k * lh);
  });
  ctx.restore();
}

/**
 * 端末上でクリップを連結して 1 本の mp4 にする。
 * 解像度と向きがクリップごとに違っても、縦長 720x1280 にそろえて再エンコードする。
 */
export async function makeVlog(clips: { video: Blob; text?: string }[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const inputs = clips.map((c) => new Input({ source: new BlobSource(c.video), formats: ALL_FORMATS }));
  try {
    const tracks = await Promise.all(
      inputs.map(async (input) => {
        const video = await input.getPrimaryVideoTrack();
        const audio = await input.getPrimaryAudioTrack();
        return {
          video: video && (await video.canDecode()) ? video : null,
          audio: audio && (await audio.canDecode()) ? audio : null,
          duration: await input.computeDuration(),
        };
      }),
    );
    const hasAudio = tracks.some((t) => t.audio);

    const videoCodec = (await canEncode("avc")) ? "avc" : "vp9";
    const audioCodec = (await canEncode("aac")) ? "aac" : "opus";
    const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext("2d")!;
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: QUALITY_MEDIUM });
    output.addVideoTrack(videoSource, { frameRate: 30 });
    const audioSource = hasAudio
      ? new AudioSampleSource({ codec: audioCodec, bitrate: QUALITY_MEDIUM, transform: { sampleRate: 48000, numberOfChannels: 2 } })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    let offset = 0;
    for (const [i, t] of tracks.entries()) {
      let length = t.duration;
      if (t.video) {
        const first = await t.video.getFirstTimestamp();
        const sink = new CanvasSink(t.video, { width: WIDTH, height: HEIGHT, fit: "contain" });
        let end = 0;
        for await (const frame of sink.canvases()) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, WIDTH, HEIGHT);
          ctx.drawImage(frame.canvas, 0, 0);
          const text = clips[i]!.text;
          if (text) drawOverlayText(ctx, text);
          const ts = frame.timestamp - first;
          await videoSource.add(offset + ts, frame.duration);
          end = Math.max(end, ts + frame.duration);
        }
        if (end > 0) length = end;
      }
      if (t.audio && audioSource) {
        const first = await t.audio.getFirstTimestamp();
        for await (const sample of new AudioSampleSink(t.audio).samples()) {
          const ts = sample.timestamp - first;
          if (ts < length) {
            sample.setTimestamp(offset + ts);
            await audioSource.add(sample);
          }
          sample.close();
        }
      }
      offset += length;
      onProgress?.(i + 1, tracks.length);
    }
    await output.finalize();
    return new Blob([output.target.buffer!], { type: "video/mp4" });
  } finally {
    for (const input of inputs) input.dispose();
  }
}
