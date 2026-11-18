// Acceptance tests for categorized GIF decoding errors.
//
// 1. Regression: valid GIFs must decode byte-identically to the pristine
//    HEAD version of omggif.js (normal decode results unchanged).
// 2. Malformed sample matrix: truncated streams, bad headers, LZW overflow
//    and unsupported extensions must throw categorized GifErrors carrying a
//    byte offset, linked to the decoder state machine.
//
// Run with: node test/error_classification.js

"use strict";

var assert = require('assert');
var child_process = require('child_process');
var path = require('path');

var omggif = require(path.join(__dirname, '..', 'omggif.js'));
var GifError = omggif.GifError;
var Cat = omggif.GifErrorCategory;

// Load the unmodified HEAD version for regression comparison.
var origSrc = child_process.execSync(
    'git show HEAD:omggif.js',
    {cwd: path.join(__dirname, '..'), encoding: 'utf8'});
var orig = {};
new Function('exports', origSrc)(orig);

var passed = 0;
function ok(name) { console.log('ok - ' + name); ++passed; }

// ---------------------------------------------------------------------------
// Valid sample construction.
// ---------------------------------------------------------------------------

function buildGifBuffer(frames, gopts) {
  var buf = new Uint8Array(4096);
  var gs = new omggif.GifWriter(buf, frames[0].w, frames[0].h, gopts);
  for (var i = 0; i < frames.length; ++i)
    gs.addFrame(frames[i].x || 0, frames[i].y || 0, frames[i].w, frames[i].h,
                frames[i].pixels, frames[i].opts);
  return buf.slice(0, gs.end());
}

var PALETTE = [0x000000, 0xffffff, 0xff0000, 0x00ff00];

// A: minimal 1x1, global palette only.
var gifA = buildGifBuffer(
    [{w: 1, h: 1, pixels: [1]}], {palette: [0x000000, 0xffffff]});

// B: two frames, loop count, delay, transparency, disposal, local palette.
var gifB = buildGifBuffer(
    [{w: 2, h: 2, pixels: [0, 1, 2, 3],
      opts: {delay: 10, transparent: 3, disposal: 2}},
     {w: 2, h: 2, pixels: [3, 2, 1, 0],
      opts: {palette: PALETTE, delay: 5}}],
    {palette: PALETTE, loop: 5});

// C: B plus a comment extension and a plain text extension spliced in.
function spliceBeforeTrailer(gif, blocks) {
  var out = new Uint8Array(gif.length + blocks.length);
  out.set(gif.subarray(0, gif.length - 1), 0);
  out.set(blocks, gif.length - 1);
  out.set(gif.subarray(gif.length - 1), gif.length - 1 + blocks.length);
  return out;
}
var commentExt = [0x21, 0xfe, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00];
var plainTextExt = [0x21, 0x01, 0x0c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0,
                    0x03, 0x41, 0x42, 0x43, 0x00];
var gifC = spliceBeforeTrailer(
    gifB, commentExt.concat(plainTextExt, commentExt));

// D: 87a header variant of A.
var gifD = gifA.slice();
gifD[4] = 0x37;  // '7'

var validGifs = {A: gifA, B: gifB, C: gifC, D: gifD};

// ---------------------------------------------------------------------------
// Regression: valid GIFs decode identically to the HEAD version.
// ---------------------------------------------------------------------------

function decodeAll(mod, bytes) {
  var r = new mod.GifReader(bytes);
  var out = {width: r.width, height: r.height, numFrames: r.numFrames(),
             loopCount: r.loopCount(), frames: []};
  for (var i = 0; i < r.numFrames(); ++i) {
    var rgba = new Uint8Array(r.width * r.height * 4);
    r.decodeAndBlitFrameRGBA(i, rgba);
    var bgra = new Uint8Array(r.width * r.height * 4);
    r.decodeAndBlitFrameBGRA(i, bgra);
    out.frames.push({info: r.frameInfo(i),
                     rgba: Array.from(rgba), bgra: Array.from(bgra)});
  }
  return out;
}

for (var key in validGifs) {
  assert.deepStrictEqual(decodeAll(omggif, validGifs[key]),
                         decodeAll(orig, validGifs[key]),
                         'decode mismatch for valid gif ' + key);
  ok('valid gif ' + key + ' decodes identically to HEAD');
}

// ---------------------------------------------------------------------------
// Malformed sample matrix.
// ---------------------------------------------------------------------------

function expectGifError(name, bytes, category, offset, decode) {
  try {
    var r = new omggif.GifReader(bytes);
    if (decode === true) {
      var px = new Uint8Array(r.width * r.height * 4);
      r.decodeAndBlitFrameRGBA(0, px);
    }
  } catch (e) {
    assert(e instanceof Error, name + ': not an Error');
    assert(e instanceof GifError, name + ': not a GifError (got ' + e + ')');
    assert.strictEqual(e.category, category,
                       name + ': category ' + e.category + ' !== ' + category);
    assert.strictEqual(typeof e.offset, 'number', name + ': no offset');
    assert(e.offset >= 0 && e.offset <= bytes.length,
           name + ': offset out of range: ' + e.offset);
    if (offset !== undefined)
      assert.strictEqual(e.offset, offset,
                         name + ': offset ' + e.offset + ' !== ' + offset);
    assert(e.message.indexOf(category) !== -1,
           name + ': message lacks category');
    ok(name + ' -> ' + category + ' @' + e.offset);
    return e;
  }
  assert.fail(name + ': expected ' + category + ' error, decoded fine');
}

// -- Bad headers ------------------------------------------------------------
expectGifError('bad header: GIF88a', (function() {
  var b = gifA.slice(); b[4] = 0x38; return b; })(), Cat.BAD_HEADER, 0);
expectGifError('bad header: not a gif',
               new Uint8Array([0x4e, 0x4f, 0x54, 0x47, 0x49, 0x46, 0, 0, 0, 0,
                               0, 0, 0]),
               Cat.BAD_HEADER, 0);

// -- Truncation --------------------------------------------------------------
expectGifError('truncated: empty buffer', new Uint8Array(0),
               Cat.TRUNCATED, 0);
expectGifError('truncated: "GIF" only', new Uint8Array([0x47, 0x49, 0x46]),
               Cat.TRUNCATED, 0);
expectGifError('truncated: header only',
               gifA.slice(0, 6), Cat.TRUNCATED, 6);

// Truncation sweep: every proper prefix of the richest valid gif must throw
// a categorized truncation error (state machine linked: message carries the
// parser state in which the stream ran out).
for (var end = 0; end < gifC.length; ++end) {
  var e = expectGifError('truncated: prefix[' + end + ' of gifC',
                         gifC.slice(0, end), Cat.TRUNCATED);
  assert(/state: "|state "/.test(e.message) || e.message.indexOf('state') !== -1,
         'truncation error lacks parser state: ' + e.message);
}
ok('truncation sweep: all ' + gifC.length + ' prefixes categorized');

// -- Unsupported extension ---------------------------------------------------
var gifUnknownExt = spliceBeforeTrailer(gifA, [0x21, 0x99, 0x00]);
expectGifError('unsupported extension label 0x99', gifUnknownExt,
               Cat.UNSUPPORTED_EXTENSION, gifA.length - 1 + 1);

// -- Malformed blocks --------------------------------------------------------
var gifUnknownBlock = spliceBeforeTrailer(gifA, [0x99]);
expectGifError('unknown top-level block', gifUnknownBlock,
               Cat.MALFORMED, gifA.length - 1);

var gifBadGce = spliceBeforeTrailer(
    gifA, [0x21, 0xf9, 0x03, 0x00, 0x00, 0x00, 0x00]);
expectGifError('graphics control ext with bad size', gifBadGce,
               Cat.MALFORMED, gifA.length - 1 + 2);

// Bad LZW min code size (patch the codesize byte of a valid gif).
var gifBadCodeSize = gifA.slice();
var dataOffset = (function() {
  var r = new omggif.GifReader(gifA);
  return r.frameInfo(0).data_offset;
})();
gifBadCodeSize[dataOffset] = 9;
expectGifError('LZW min code size 9', gifBadCodeSize,
               Cat.MALFORMED, dataOffset, true);

// -- LZW overflow -------------------------------------------------------------
// Take a valid 2x2 gif and shrink the image descriptor to 1x1: the LZW
// stream then decodes more pixels than the frame holds.
var gifOverflow = gifB.slice();
var sep = -1;
for (var i = 13; i < gifOverflow.length; ++i) {
  if (gifOverflow[i] === 0x2c) { sep = i; break; }
}
assert(sep !== -1, 'no image separator found');
gifOverflow[sep + 5] = 1; gifOverflow[sep + 6] = 0;  // width  = 1
gifOverflow[sep + 7] = 1; gifOverflow[sep + 8] = 0;  // height = 1
expectGifError('LZW overflow (2x2 stream in 1x1 frame)', gifOverflow,
               Cat.LZW_OVERFLOW, undefined, true);

// -- Truncated LZW stream (container intact, codes missing EOI) --------------
// Hand-crafted 2x2 gif whose image data holds only a clear code.
var gifNoEoi = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,              // GIF89a
  0x02, 0x00, 0x02, 0x00, 0x80, 0x00, 0x00,        // LSD, 2x2, GCT flag
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,              // GCT: black, white
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,  // image desc
  0x02,                                            // LZW min code size
  0x01, 0x04,                                      // sub-block: clear code
  0x00,                                            // terminator
  0x3b]);                                          // trailer
expectGifError('LZW stream without EOI', gifNoEoi, Cat.TRUNCATED,
               undefined, true);

// -- Missing trailer ----------------------------------------------------------
expectGifError('missing trailer', gifA.slice(0, gifA.length - 1),
               Cat.TRUNCATED, gifA.length - 1);

console.log('\nAll ' + passed + ' checks passed.');
