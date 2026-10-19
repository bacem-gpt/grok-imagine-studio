// Colour-faithful frame decoding through Mediabunny/WebCodecs.
// Chrome's <video> element assumes BT.601 ('smpte170m') for untagged VP8/VP9 and for untagged H.264 below 720 lines,
// BT.709 otherwise; WebCodecs decoding always assumes BT.709. Untagged SD footage would therefore decode with shifted
// colours (reds turn orange, greens darken) unless frames are re-tagged with BT.601 metadata. Used by thumbnails and
// frame grabs (core/media.js) so stills match the preview.

export function untaggedVideoMatrix(codec, codedHeight) {
  if (codec === 'vp8' || codec === 'vp9') return 'smpte170m';
  if (codec === 'avc') return codedHeight < 720 ? 'smpte170m' : 'bt709';
  return 'bt709';
}

export const BT601_COLORSPACE = Object.freeze({ primaries: 'bt709', transfer: 'bt709', matrix: 'smpte170m', fullRange: false });

/**
 * Opens the primary video track of a blob for frame access.
 * Returns {input, track, sink, first, retag} — call input.dispose() when done.
 */
export async function openVideoFrames(MB, blob) {
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(blob) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track');
    let first = 0;
    let retag = false;
    try {
      first = Math.max(0, (await track.getFirstTimestamp()) || 0);
    } catch {
      /* assume 0 */
    }
    try {
      const cs = await track.getColorSpace();
      if (!cs?.matrix) retag = untaggedVideoMatrix(await track.getCodec(), await track.getCodedHeight()) === 'smpte170m';
    } catch {
      /* keep the decoder's interpretation */
    }
    // Re-tagging copies the decoded planes, so ask for CPU-backed frames.
    const sink = new MB.VideoSampleSink(track, retag ? { hardwareAcceleration: 'prefer-software' } : undefined);
    return { input, track, sink, first, retag };
  } catch (e) {
    input.dispose?.();
    throw e;
  }
}

/**
 * Re-wraps a decoded sample with BT.601 colour metadata (same YUV planes) so it draws like Chrome's <video>.
 * Closes the input sample on success. Falls back to the original sample (and sets holder.retag = false) when the
 * frame can't be copied (e.g. an opaque GPU frame).
 */
export async function retagSample(MB, sample, holder = {}) {
  try {
    if (!sample.format) throw new Error('opaque frame format');
    const size = sample.allocationSize();
    if (!holder.retagBuf || holder.retagBuf.byteLength < size) holder.retagBuf = new Uint8Array(size);
    const buf = holder.retagBuf.subarray(0, size);
    const layout = await sample.copyTo(buf);
    const vr = sample.visibleRect;
    const frame = new VideoFrame(buf, {
      format: sample.format,
      codedWidth: vr.width,
      codedHeight: vr.height,
      timestamp: Math.round(sample.timestamp * 1e6),
      duration: sample.duration > 0 ? Math.round(sample.duration * 1e6) : undefined,
      layout,
      displayWidth: sample.squarePixelWidth,
      displayHeight: sample.squarePixelHeight,
      colorSpace: BT601_COLORSPACE,
    });
    let out;
    try {
      out = new MB.VideoSample(frame, { rotation: sample.rotation, flip: sample.flip });
    } catch (e) {
      frame.close();
      throw e;
    }
    sample.close();
    return out;
  } catch (e) {
    holder.retag = false;
    console.warn('[gis] keeping decoder colours for an untagged clip', e);
    return sample;
  }
}

/** Decoded sample -> {image, width, height} drawable source (rotation applied when needed). */
export function sampleImage(sample) {
  const image = sample.toCanvasImageSource();
  const width = image.displayWidth || image.width || sample.displayWidth;
  const height = image.displayHeight || image.height || sample.displayHeight;
  return { image, width, height };
}
