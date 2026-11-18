// Acceptance test for GifStreamReader (streaming / frame-by-frame decoding).
//
//   node --expose-gc test_streaming.js
//
// 1. Correctness: for several generated GIFs (sub-rect frames, local/global
//    palettes, transparency, all disposal modes, interlacing, loop count),
//    the streaming decoder is fed with many different chunk sizes and each
//    frame's pixels are SHA-1 compared against GifReader's whole-file
//    decodeAndBlitFrameRGBA/BGRA output.  The composited canvas is compared
//    against an independent whole-file compositor.
// 2. Memory: a long (hundreds of frames) GIF is decoded both ways and peak
//    RSS / heap are compared; the frame hashes must still match.

"use strict";

var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var omggif = require('./omggif.js');
var GifReader = omggif.GifReader;
var GifWriter = omggif.GifWriter;
var GifStreamReader = omggif.GifStreamReader;

var failures = 0;
function check(cond, msg) {
  if (!cond) { ++failures; console.error("FAIL: " + msg); }
}
function section(msg) { console.log("== " + msg); }

function sha1(u8) {
  return crypto.createHash('sha1')
      .update(Buffer.from(u8.buffer, u8.byteOffset, u8.length))
      .digest('hex');
}

function lcg(seed) {
  return function() {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed;
  };
}

function makePalette(fn) {
  var p = [];
  for (var i = 0; i < 256; ++i) p.push(fn(i) & 0xffffff);
  return p;
}

// --- Test GIF A: kitchen sink ---------------------------------------------
// Sub-rect frames, local + global palettes, transparency, disposal 0-3,
// delays, Netscape loop count.  Some frames intentionally emit no Graphics
// Control Extension so the "sticky" GCE state is exercised.
function buildGifA() {
  var W = 64, H = 48, nframes = 120;
  var buf = new Uint8Array(8 * 1024 * 1024);
  var globalPal = makePalette(function(i) { return (i << 16) | ((255-i) << 8) | (i * 37); });
  var localPal = makePalette(function(i) { return ((i * 3) << 16) | ((i * 5) << 8) | (255 - i); });
  var gw = new GifWriter(buf, W, H, {palette: globalPal, loop: 1});
  var rnd = lcg(42);
  for (var f = 0; f < nframes; ++f) {
    var w = 24, h = 20;
    var x = (f * 3) % (W - w), y = (f * 2) % (H - h);
    var px = new Uint8Array(w * h);
    for (var j = 0; j < px.length; ++j) px[j] = rnd() & 0xff;
    var opts = {};
    if (f % 3 === 1) opts.palette = localPal;
    if (f % 4 === 2) opts.transparent = 5;
    opts.disposal = f % 4;
    if (f % 5 === 0) opts.delay = f % 7;
    gw.addFrame(x, y, w, h, px, opts);
  }
  return buf.subarray(0, gw.end());
}

// --- Test GIF B: interlaced frames ----------------------------------------
// GifWriter does not emit interlaced GIFs, so rows are pre-rearranged into
// interlace pass order and the interlace flag is flipped afterwards.
function buildGifB() {
  var W = 32, H = 32, nframes = 25;
  var buf = new Uint8Array(1024 * 1024);
  var globalPal = makePalette(function(i) { return (i << 16) | (i << 8) | i; });
  var gw = new GifWriter(buf, W, H, {palette: globalPal});
  var rnd = lcg(7);
  for (var f = 0; f < nframes; ++f) {
    var w = 20 + (f % 8), h = 16 + (f % 6);
    var x = f % (W - w), y = (f * 2) % (H - h);
    var px = new Uint8Array(w * h);
    for (var j = 0; j < px.length; ++j) px[j] = rnd() & 0xff;
    // Rearrange rows into GIF interlace pass order: 0+8k, 4+8k, 2+4k, 1+2k.
    var re = new Uint8Array(w * h);
    var o = 0;
    var starts = [0, 4, 2, 1], steps = [8, 8, 4, 2];
    for (var pass = 0; pass < 4; ++pass) {
      for (var row = starts[pass]; row < h; row += steps[pass]) {
        re.set(px.subarray(row * w, (row + 1) * w), o);
        o += w;
      }
    }
    var before = gw.getOutputBufferPosition();  // No GCE -> descriptor here.
    gw.addFrame(x, y, w, h, re, {});
    buf[before + 9] |= 0x40;  // Set the interlace flag in the packed fields.
  }
  return buf.subarray(0, gw.end());
}

// --- Test GIF C: minimal 1x1 ----------------------------------------------
function buildGifC() {
  var buf = new Uint8Array(256);
  var gw = new GifWriter(buf, 1, 1, {palette: [0x000000, 0xffffff]});
  gw.addFrame(0, 0, 1, 1 ? 1 : 1, new Uint8Array([1]), {});
  return buf.subarray(0, gw.end());
}

// --- Reference compositor (independent of the streaming implementation) ---
function referenceCompositeHashes(gr) {
  var W = gr.width, H = gr.height;
  var canvas = new Uint8Array(W * H * 4);
  var hashes = [];
  var prev = null, saved = null, savedDims = null;
  for (var i = 0; i < gr.numFrames(); ++i) {
    var info = gr.frameInfo(i);
    if (prev !== null) {
      if (prev.disposal === 2) {
        for (var r = 0; r < prev.height; ++r)
          canvas.fill(0, ((prev.y + r) * W + prev.x) * 4,
                         ((prev.y + r) * W + prev.x + prev.width) * 4);
      } else if (prev.disposal === 3 && saved !== null) {
        for (var r = 0; r < savedDims.height; ++r)
          canvas.set(saved.subarray(r * savedDims.width * 4,
                                    (r + 1) * savedDims.width * 4),
                     ((savedDims.y + r) * W + savedDims.x) * 4);
      }
    }
    if (info.disposal === 3) {
      savedDims = {x: info.x, y: info.y, width: info.width, height: info.height};
      saved = new Uint8Array(info.width * info.height * 4);
      for (var r = 0; r < info.height; ++r)
        saved.set(canvas.subarray(((info.y + r) * W + info.x) * 4,
                                  ((info.y + r) * W + info.x + info.width) * 4),
                  r * info.width * 4);
    }
    gr.decodeAndBlitFrameRGBA(i, canvas);
    hashes.push(sha1(canvas));
    prev = {x: info.x, y: info.y, width: info.width, height: info.height,
            disposal: info.disposal};
  }
  return hashes;
}

var INFO_FIELDS = ['x', 'y', 'width', 'height', 'has_local_palette',
                   'transparent_index', 'interlaced', 'delay', 'disposal'];

// Run the streaming decoder over |gif| with the given chunk size, collecting
// per-frame + composite hashes and frame infos.
function streamDecode(gif, chunkSize, opts) {
  var result = {frames: [], composites: [], infos: [], header: null,
                ends: 0, errors: []};
  var sr = new GifStreamReader(opts);
  sr.onheader = function(h) { result.header = h; };
  sr.onframe = function(frame, framePixels, canvas) {
    result.infos.push(frame);
    result.frames.push(sha1(framePixels));
    result.composites.push(sha1(canvas));
  };
  sr.onend = function() { ++result.ends; };
  sr.onerror = function(e) { result.errors.push(e); };
  for (var off = 0; off < gif.length; off += chunkSize)
    sr.push(gif.subarray(off, Math.min(off + chunkSize, gif.length)));
  sr.finish();
  result.reader = sr;
  return result;
}

function correctnessTest(label, gif) {
  section(label + " (" + gif.length + " bytes)");
  var gr = new GifReader(gif);
  var W = gr.width, H = gr.height, n = gr.numFrames();

  // Whole-file reference: per-frame RGBA blits into a zeroed buffer.
  var refFrames = [];
  var z = new Uint8Array(W * H * 4);
  for (var i = 0; i < n; ++i) {
    z.fill(0);
    gr.decodeAndBlitFrameRGBA(i, z);
    refFrames.push(sha1(z));
  }
  var refComposites = referenceCompositeHashes(gr);
  var refInfos = [];
  for (var i = 0; i < n; ++i) refInfos.push(gr.frameInfo(i));

  var chunkSizes = [1, 2, 3, 5, 7, 13, 100, 1024, 65535, gif.length];
  for (var c = 0; c < chunkSizes.length; ++c) {
    var cs = chunkSizes[c];
    var res = streamDecode(gif, cs);
    var tag = label + " chunk=" + cs;
    check(res.errors.length === 0, tag + ": unexpected errors " + res.errors);
    check(res.ends === 1, tag + ": onend fired " + res.ends + " times");
    check(res.frames.length === n,
          tag + ": frame count " + res.frames.length + " != " + n);
    check(res.header !== null && res.header.width === W &&
          res.header.height === H, tag + ": header mismatch");
    check(res.reader.loopCount === gr.loopCount(),
          tag + ": loopCount " + res.reader.loopCount + " != " + gr.loopCount());
    for (var i = 0; i < Math.min(res.frames.length, n); ++i) {
      if (res.frames[i] !== refFrames[i]) {
        check(false, tag + ": frame " + i + " RGBA hash mismatch");
        break;
      }
      if (res.composites[i] !== refComposites[i]) {
        check(false, tag + ": frame " + i + " composite hash mismatch");
        break;
      }
      for (var f = 0; f < INFO_FIELDS.length; ++f) {
        var k = INFO_FIELDS[f];
        if (res.infos[i][k] !== refInfos[i][k]) {
          check(false, tag + ": frame " + i + " info." + k + " " +
                res.infos[i][k] + " != " + refInfos[i][k]);
          break;
        }
      }
    }
  }

  // BGRA parity (single chunking is enough, shares the whole pipeline).
  var refBGRA = [];
  for (var i = 0; i < n; ++i) {
    z.fill(0);
    gr.decodeAndBlitFrameBGRA(i, z);
    refBGRA.push(sha1(z));
  }
  var resB = streamDecode(gif, 4096, {format: 'bgra'});
  check(resB.frames.length === n, label + ": bgra frame count");
  for (var i = 0; i < Math.min(resB.frames.length, n); ++i) {
    if (resB.frames[i] !== refBGRA[i]) {
      check(false, label + ": frame " + i + " BGRA hash mismatch");
      break;
    }
  }
  console.log("   frames=" + n + " OK");
}

function errorHandlingTest(gif) {
  section("error handling");
  // Bad header.
  var threw = false;
  try {
    var sr = new GifStreamReader();
    sr.push(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
  } catch (e) { threw = /Invalid GIF/.test(e.message); }
  check(threw, "invalid header should throw");

  // onerror delivery instead of throw.
  var got = null;
  var sr2 = new GifStreamReader();
  sr2.onerror = function(e) { got = e; };
  sr2.push(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
  check(got !== null && /Invalid GIF/.test(got.message),
        "invalid header should reach onerror");

  // Truncated stream.
  got = null;
  var sr3 = new GifStreamReader();
  sr3.onerror = function(e) { got = e; };
  sr3.push(gif.subarray(0, gif.length >> 1));
  sr3.finish();
  check(got !== null && /Truncated/.test(got.message),
        "truncated stream should report an error, got " + got);

  // finish() at a clean boundary without a trailer is tolerated.
  var ends = 0, errs = 0;
  var sr4 = new GifStreamReader();
  sr4.onend = function() { ++ends; };
  sr4.onerror = function() { ++errs; };
  // Push header + LSD + GCT only (13 + 768 bytes for GIF A).
  sr4.push(gif.subarray(0, 13 + 768));
  sr4.finish();
  check(ends === 1 && errs === 0, "clean-boundary finish should end quietly");

  // Bytes after the trailer are ignored.
  var n0 = 0;
  var sr5 = new GifStreamReader();
  sr5.onframe = function() { ++n0; };
  sr5.push(gif);
  sr5.push(new Uint8Array([1, 2, 3]));
  sr5.finish();
  check(n0 === new GifReader(gif).numFrames(),
        "bytes after trailer should be ignored");
}

// --- Memory benchmark ------------------------------------------------------
// Each scenario runs in a fresh child process (RSS does not shrink, so two
// scenarios cannot be compared within one process).
function xorshift32(seed) {
  var s = seed >>> 0;
  return function() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

function buildLongGif(filePath) {
  var W = 400, H = 300, nframes = 300;
  var buf = new Uint8Array(256 * 1024 * 1024);
  var pal = makePalette(function(i) { return (i << 16) | ((i * 3) << 8) | i; });
  var gw = new GifWriter(buf, W, H, {palette: pal, loop: 0});
  var rnd = xorshift32(1234);
  var px = new Uint8Array(W * H);
  for (var f = 0; f < nframes; ++f) {
    for (var j = 0; j < px.length; ++j) px[j] = rnd() & 0xff;  // Noise: big file.
    gw.addFrame(0, 0, W, H, px, {delay: 5});
  }
  var end = gw.end();
  fs.writeFileSync(filePath, Buffer.from(buf.buffer, 0, end));
  return end;
}

function memUsage() {
  var m = process.memoryUsage();
  return {rss: m.rss, heap: m.heapUsed};
}
function mb(b) { return (b / 1048576).toFixed(1); }

// Child-process entry points: decode the file one way, print peak usage and
// the concatenated frame hash as JSON.
function memChild(mode, filePath) {
  var peak = {rss: 0, heap: 0};
  function track() {
    var m = memUsage();
    if (m.rss > peak.rss) peak.rss = m.rss;
    if (m.heap > peak.heap) peak.heap = m.heap;
  }
  var hash = crypto.createHash('sha1');
  var frames = 0;
  if (mode === 'whole') {
    var buf = fs.readFileSync(filePath);
    var gr = new GifReader(buf);
    var z = new Uint8Array(gr.width * gr.height * 4);
    for (var i = 0; i < gr.numFrames(); ++i) {
      z.fill(0);
      gr.decodeAndBlitFrameRGBA(i, z);
      hash.update(z);
      ++frames;
      track();
    }
  } else {  // 'stream': feed 64 KB chunks straight from disk.
    var sr = new GifStreamReader();
    sr.onframe = function(frame, framePixels) {
      hash.update(Buffer.from(framePixels.buffer, 0, framePixels.length));
      ++frames;
      track();
    };
    var fd = fs.openSync(filePath, 'r');
    var chunk = new Uint8Array(64 * 1024);
    while (true) {
      var nread = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (nread === 0) break;
      sr.push(chunk.subarray(0, nread));
    }
    fs.closeSync(fd);
    sr.finish();
  }
  track();
  console.log(JSON.stringify(
      {mode: mode, frames: frames, hash: hash.digest('hex'),
       peakRss: peak.rss, peakHeap: peak.heap}));
}

function runMemChild(mode, filePath) {
  var res = require('child_process').execFileSync(
      process.execPath, [__filename, '--mem-' + mode, filePath],
      {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  return JSON.parse(res.trim().split('\n').pop());
}

function memoryTest(filePath) {
  var fsize = fs.statSync(filePath).size;
  section("memory: long GIF (" + mb(fsize) + " MB file)");
  var whole = runMemChild('whole', filePath);
  var stream = runMemChild('stream', filePath);
  console.log("   whole-file : peak rss " + mb(whole.peakRss) +
              " MB, peak heap " + mb(whole.peakHeap) + " MB");
  console.log("   streaming  : peak rss " + mb(stream.peakRss) +
              " MB, peak heap " + mb(stream.peakHeap) + " MB");
  console.log("   frames=" + stream.frames +
              "  frame-hash(concat) equal: " + (whole.hash === stream.hash));
  check(whole.frames === stream.frames, "frame count mismatch in memory test");
  check(whole.hash === stream.hash,
        "streaming frame hashes differ from whole-file decode");
  check(stream.peakRss < whole.peakRss - fsize / 2,
        "streaming peak rss (" + mb(stream.peakRss) +
        " MB) should be well below whole-file peak (" + mb(whole.peakRss) +
        " MB)");
}

function main() {
  // Child-process mode for the memory benchmark.
  var memArg = process.argv.indexOf('--mem-whole');
  if (memArg === -1) memArg = process.argv.indexOf('--mem-stream');
  if (memArg !== -1) {
    memChild(process.argv[memArg].slice(6), process.argv[memArg + 1]);
    return;
  }

  var gifA = buildGifA();
  var gifB = buildGifB();
  var gifC = buildGifC();
  correctnessTest("GIF A (kitchen sink)", gifA);
  correctnessTest("GIF B (interlaced)", gifB);
  correctnessTest("GIF C (1x1)", gifC);
  errorHandlingTest(gifA);

  var tmp = path.join(os.tmpdir(), "omggif_stream_test_long.gif");
  try {
    console.log("== generating long GIF (this can take a moment)...");
    var size = buildLongGif(tmp);
    console.log("   wrote " + mb(size) + " MB to " + tmp);
    memoryTest(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }

  if (failures > 0) {
    console.error("\n" + failures + " FAILURE(S)");
    process.exit(1);
  }
  console.log("\nAll tests passed.");
}

main();
