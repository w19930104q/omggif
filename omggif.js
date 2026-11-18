// (c) Dean McNamee <dean@gmail.com>, 2013.
//
// https://github.com/deanm/omggif
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.
//
// omggif is a JavaScript implementation of a GIF 89a encoder and decoder,
// including animation and compression.  It does not rely on any specific
// underlying system, so should run in the browser, Node, or Plask.

"use strict";

function GifWriter(buf, width, height, gopts) {
  var p = 0;

  var gopts = gopts === undefined ? { } : gopts;
  var loop_count = gopts.loop === undefined ? null : gopts.loop;
  var global_palette = gopts.palette === undefined ? null : gopts.palette;

  if (width <= 0 || height <= 0 || width > 65535 || height > 65535)
    throw new Error("Width/Height invalid.");

  function check_palette_and_num_colors(palette) {
    var num_colors = palette.length;
    if (num_colors < 2 || num_colors > 256 ||  num_colors & (num_colors-1)) {
      throw new Error(
          "Invalid code/color length, must be power of 2 and 2 .. 256.");
    }
    return num_colors;
  }

  // - Header.
  buf[p++] = 0x47; buf[p++] = 0x49; buf[p++] = 0x46;  // GIF
  buf[p++] = 0x38; buf[p++] = 0x39; buf[p++] = 0x61;  // 89a

  // Handling of Global Color Table (palette) and background index.
  var gp_num_colors_pow2 = 0;
  var background = 0;
  if (global_palette !== null) {
    var gp_num_colors = check_palette_and_num_colors(global_palette);
    while (gp_num_colors >>= 1) ++gp_num_colors_pow2;
    gp_num_colors = 1 << gp_num_colors_pow2;
    --gp_num_colors_pow2;
    if (gopts.background !== undefined) {
      background = gopts.background;
      if (background >= gp_num_colors)
        throw new Error("Background index out of range.");
      // The GIF spec states that a background index of 0 should be ignored, so
      // this is probably a mistake and you really want to set it to another
      // slot in the palette.  But actually in the end most browsers, etc end
      // up ignoring this almost completely (including for dispose background).
      if (background === 0)
        throw new Error("Background index explicitly passed as 0.");
    }
  }

  // - Logical Screen Descriptor.
  // NOTE(deanm): w/h apparently ignored by implementations, but set anyway.
  buf[p++] = width & 0xff; buf[p++] = width >> 8 & 0xff;
  buf[p++] = height & 0xff; buf[p++] = height >> 8 & 0xff;
  // NOTE: Indicates 0-bpp original color resolution (unused?).
  buf[p++] = (global_palette !== null ? 0x80 : 0) |  // Global Color Table Flag.
             gp_num_colors_pow2;  // NOTE: No sort flag (unused?).
  buf[p++] = background;  // Background Color Index.
  buf[p++] = 0;  // Pixel aspect ratio (unused?).

  // - Global Color Table
  if (global_palette !== null) {
    for (var i = 0, il = global_palette.length; i < il; ++i) {
      var rgb = global_palette[i];
      buf[p++] = rgb >> 16 & 0xff;
      buf[p++] = rgb >> 8 & 0xff;
      buf[p++] = rgb & 0xff;
    }
  }

  if (loop_count !== null) {  // Netscape block for looping.
    if (loop_count < 0 || loop_count > 65535)
      throw new Error("Loop count invalid.");
    // Extension code, label, and length.
    buf[p++] = 0x21; buf[p++] = 0xff; buf[p++] = 0x0b;
    // NETSCAPE2.0
    buf[p++] = 0x4e; buf[p++] = 0x45; buf[p++] = 0x54; buf[p++] = 0x53;
    buf[p++] = 0x43; buf[p++] = 0x41; buf[p++] = 0x50; buf[p++] = 0x45;
    buf[p++] = 0x32; buf[p++] = 0x2e; buf[p++] = 0x30;
    // Sub-block
    buf[p++] = 0x03; buf[p++] = 0x01;
    buf[p++] = loop_count & 0xff; buf[p++] = loop_count >> 8 & 0xff;
    buf[p++] = 0x00;  // Terminator.
  }


  var ended = false;

  this.addFrame = function(x, y, w, h, indexed_pixels, opts) {
    if (ended === true) { --p; ended = false; }  // Un-end.

    opts = opts === undefined ? { } : opts;

    // TODO(deanm): Bounds check x, y.  Do they need to be within the virtual
    // canvas width/height, I imagine?
    if (x < 0 || y < 0 || x > 65535 || y > 65535)
      throw new Error("x/y invalid.");

    if (w <= 0 || h <= 0 || w > 65535 || h > 65535)
      throw new Error("Width/Height invalid.");

    if (indexed_pixels.length < w * h)
      throw new Error("Not enough pixels for the frame size.");

    var using_local_palette = true;
    var palette = opts.palette;
    if (palette === undefined || palette === null) {
      using_local_palette = false;
      palette = global_palette;
    }

    if (palette === undefined || palette === null)
      throw new Error("Must supply either a local or global palette.");

    var num_colors = check_palette_and_num_colors(palette);

    // Compute the min_code_size (power of 2), destroying num_colors.
    var min_code_size = 0;
    while (num_colors >>= 1) ++min_code_size;
    num_colors = 1 << min_code_size;  // Now we can easily get it back.

    var delay = opts.delay === undefined ? 0 : opts.delay;

    // From the spec:
    //     0 -   No disposal specified. The decoder is
    //           not required to take any action.
    //     1 -   Do not dispose. The graphic is to be left
    //           in place.
    //     2 -   Restore to background color. The area used by the
    //           graphic must be restored to the background color.
    //     3 -   Restore to previous. The decoder is required to
    //           restore the area overwritten by the graphic with
    //           what was there prior to rendering the graphic.
    //  4-7 -    To be defined.
    // NOTE(deanm): Dispose background doesn't really work, apparently most
    // browsers ignore the background palette index and clear to transparency.
    var disposal = opts.disposal === undefined ? 0 : opts.disposal;
    if (disposal < 0 || disposal > 3)  // 4-7 is reserved.
      throw new Error("Disposal out of range.");

    var use_transparency = false;
    var transparent_index = 0;
    if (opts.transparent !== undefined && opts.transparent !== null) {
      use_transparency = true;
      transparent_index = opts.transparent;
      if (transparent_index < 0 || transparent_index >= num_colors)
        throw new Error("Transparent color index.");
    }

    if (disposal !== 0 || use_transparency || delay !== 0) {
      // - Graphics Control Extension
      buf[p++] = 0x21; buf[p++] = 0xf9;  // Extension / Label.
      buf[p++] = 4;  // Byte size.

      buf[p++] = disposal << 2 | (use_transparency === true ? 1 : 0);
      buf[p++] = delay & 0xff; buf[p++] = delay >> 8 & 0xff;
      buf[p++] = transparent_index;  // Transparent color index.
      buf[p++] = 0;  // Block Terminator.
    }

    // - Image Descriptor
    buf[p++] = 0x2c;  // Image Seperator.
    buf[p++] = x & 0xff; buf[p++] = x >> 8 & 0xff;  // Left.
    buf[p++] = y & 0xff; buf[p++] = y >> 8 & 0xff;  // Top.
    buf[p++] = w & 0xff; buf[p++] = w >> 8 & 0xff;
    buf[p++] = h & 0xff; buf[p++] = h >> 8 & 0xff;
    // NOTE: No sort flag (unused?).
    // TODO(deanm): Support interlace.
    buf[p++] = using_local_palette === true ? (0x80 | (min_code_size-1)) : 0;

    // - Local Color Table
    if (using_local_palette === true) {
      for (var i = 0, il = palette.length; i < il; ++i) {
        var rgb = palette[i];
        buf[p++] = rgb >> 16 & 0xff;
        buf[p++] = rgb >> 8 & 0xff;
        buf[p++] = rgb & 0xff;
      }
    }

    p = GifWriterOutputLZWCodeStream(
            buf, p, min_code_size < 2 ? 2 : min_code_size, indexed_pixels);

    return p;
  };

  this.end = function() {
    if (ended === false) {
      buf[p++] = 0x3b;  // Trailer.
      ended = true;
    }
    return p;
  };

  this.getOutputBuffer = function() { return buf; };
  this.setOutputBuffer = function(v) { buf = v; };
  this.getOutputBufferPosition = function() { return p; };
  this.setOutputBufferPosition = function(v) { p = v; };
}

// Main compression routine, palette indexes -> LZW code stream.
// |index_stream| must have at least one entry.
function GifWriterOutputLZWCodeStream(buf, p, min_code_size, index_stream) {
  buf[p++] = min_code_size;
  var cur_subblock = p++;  // Pointing at the length field.

  var clear_code = 1 << min_code_size;
  var code_mask = clear_code - 1;
  var eoi_code = clear_code + 1;
  var next_code = eoi_code + 1;

  var cur_code_size = min_code_size + 1;  // Number of bits per code.
  var cur_shift = 0;
  // We have at most 12-bit codes, so we should have to hold a max of 19
  // bits here (and then we would write out).
  var cur = 0;

  function emit_bytes_to_buffer(bit_block_size) {
    while (cur_shift >= bit_block_size) {
      buf[p++] = cur & 0xff;
      cur >>= 8; cur_shift -= 8;
      if (p === cur_subblock + 256) {  // Finished a subblock.
        buf[cur_subblock] = 255;
        cur_subblock = p++;
      }
    }
  }

  function emit_code(c) {
    cur |= c << cur_shift;
    cur_shift += cur_code_size;
    emit_bytes_to_buffer(8);
  }

  // I am not an expert on the topic, and I don't want to write a thesis.
  // However, it is good to outline here the basic algorithm and the few data
  // structures and optimizations here that make this implementation fast.
  // The basic idea behind LZW is to build a table of previously seen runs
  // addressed by a short id (herein called output code).  All data is
  // referenced by a code, which represents one or more values from the
  // original input stream.  All input bytes can be referenced as the same
  // value as an output code.  So if you didn't want any compression, you
  // could more or less just output the original bytes as codes (there are
  // some details to this, but it is the idea).  In order to achieve
  // compression, values greater then the input range (codes can be up to
  // 12-bit while input only 8-bit) represent a sequence of previously seen
  // inputs.  The decompressor is able to build the same mapping while
  // decoding, so there is always a shared common knowledge between the
  // encoding and decoder, which is also important for "timing" aspects like
  // how to handle variable bit width code encoding.
  //
  // One obvious but very important consequence of the table system is there
  // is always a unique id (at most 12-bits) to map the runs.  'A' might be
  // 4, then 'AA' might be 10, 'AAA' 11, 'AAAA' 12, etc.  This relationship
  // can be used for an effecient lookup strategy for the code mapping.  We
  // need to know if a run has been seen before, and be able to map that run
  // to the output code.  Since we start with known unique ids (input bytes),
  // and then from those build more unique ids (table entries), we can
  // continue this chain (almost like a linked list) to always have small
  // integer values that represent the current byte chains in the encoder.
  // This means instead of tracking the input bytes (AAAABCD) to know our
  // current state, we can track the table entry for AAAABC (it is guaranteed
  // to exist by the nature of the algorithm) and the next character D.
  // Therefor the tuple of (table_entry, byte) is guaranteed to also be
  // unique.  This allows us to create a simple lookup key for mapping input
  // sequences to codes (table indices) without having to store or search
  // any of the code sequences.  So if 'AAAA' has a table entry of 12, the
  // tuple of ('AAAA', K) for any input byte K will be unique, and can be our
  // key.  This leads to a integer value at most 20-bits, which can always
  // fit in an SMI value and be used as a fast sparse array / object key.

  // Output code for the current contents of the index buffer.
  var ib_code = index_stream[0] & code_mask;  // Load first input index.
  var code_table = { };  // Key'd on our 20-bit "tuple".

  emit_code(clear_code);  // Spec says first code should be a clear code.

  // First index already loaded, process the rest of the stream.
  for (var i = 1, il = index_stream.length; i < il; ++i) {
    var k = index_stream[i] & code_mask;
    var cur_key = ib_code << 8 | k;  // (prev, k) unique tuple.
    var cur_code = code_table[cur_key];  // buffer + k.

    // Check if we have to create a new code table entry.
    if (cur_code === undefined) {  // We don't have buffer + k.
      // Emit index buffer (without k).
      // This is an inline version of emit_code, because this is the core
      // writing routine of the compressor (and V8 cannot inline emit_code
      // because it is a closure here in a different context).  Additionally
      // we can call emit_byte_to_buffer less often, because we can have
      // 30-bits (from our 31-bit signed SMI), and we know our codes will only
      // be 12-bits, so can safely have 18-bits there without overflow.
      // emit_code(ib_code);
      cur |= ib_code << cur_shift;
      cur_shift += cur_code_size;
      while (cur_shift >= 8) {
        buf[p++] = cur & 0xff;
        cur >>= 8; cur_shift -= 8;
        if (p === cur_subblock + 256) {  // Finished a subblock.
          buf[cur_subblock] = 255;
          cur_subblock = p++;
        }
      }

      if (next_code === 4096) {  // Table full, need a clear.
        emit_code(clear_code);
        next_code = eoi_code + 1;
        cur_code_size = min_code_size + 1;
        code_table = { };
      } else {  // Table not full, insert a new entry.
        // Increase our variable bit code sizes if necessary.  This is a bit
        // tricky as it is based on "timing" between the encoding and
        // decoder.  From the encoders perspective this should happen after
        // we've already emitted the index buffer and are about to create the
        // first table entry that would overflow our current code bit size.
        if (next_code >= (1 << cur_code_size)) ++cur_code_size;
        code_table[cur_key] = next_code++;  // Insert into code table.
      }

      ib_code = k;  // Index buffer to single input k.
    } else {
      ib_code = cur_code;  // Index buffer to sequence in code table.
    }
  }

  emit_code(ib_code);  // There will still be something in the index buffer.
  emit_code(eoi_code);  // End Of Information.

  // Flush / finalize the sub-blocks stream to the buffer.
  emit_bytes_to_buffer(1);

  // Finish the sub-blocks, writing out any unfinished lengths and
  // terminating with a sub-block of length 0.  If we have already started
  // but not yet used a sub-block it can just become the terminator.
  if (cur_subblock + 1 === p) {  // Started but unused.
    buf[cur_subblock] = 0;
  } else {  // Started and used, write length and additional terminator block.
    buf[cur_subblock] = p - cur_subblock - 1;
    buf[p++] = 0;
  }
  return p;
}

function GifReader(buf) {
  var p = 0;

  // - Header (GIF87a or GIF89a).
  if (buf[p++] !== 0x47 ||            buf[p++] !== 0x49 || buf[p++] !== 0x46 ||
      buf[p++] !== 0x38 || (buf[p++]+1 & 0xfd) !== 0x38 || buf[p++] !== 0x61) {
    throw new Error("Invalid GIF 87a/89a header.");
  }

  // - Logical Screen Descriptor.
  var width = buf[p++] | buf[p++] << 8;
  var height = buf[p++] | buf[p++] << 8;
  var pf0 = buf[p++];  // <Packed Fields>.
  var global_palette_flag = pf0 >> 7;
  var num_global_colors_pow2 = pf0 & 0x7;
  var num_global_colors = 1 << (num_global_colors_pow2 + 1);
  var background = buf[p++];
  buf[p++];  // Pixel aspect ratio (unused?).

  var global_palette_offset = null;
  var global_palette_size   = null;

  if (global_palette_flag) {
    global_palette_offset = p;
    global_palette_size = num_global_colors;
    p += num_global_colors * 3;  // Seek past palette.
  }

  var no_eof = true;

  var frames = [ ];

  var delay = 0;
  var transparent_index = null;
  var disposal = 0;  // 0 - No disposal specified.
  var loop_count = null;

  this.width = width;
  this.height = height;

  while (no_eof && p < buf.length) {
    switch (buf[p++]) {
      case 0x21:  // Graphics Control Extension Block
        switch (buf[p++]) {
          case 0xff:  // Application specific block
            // Try if it's a Netscape block (with animation loop counter).
            if (buf[p   ] !== 0x0b ||  // 21 FF already read, check block size.
                // NETSCAPE2.0
                buf[p+1 ] == 0x4e && buf[p+2 ] == 0x45 && buf[p+3 ] == 0x54 &&
                buf[p+4 ] == 0x53 && buf[p+5 ] == 0x43 && buf[p+6 ] == 0x41 &&
                buf[p+7 ] == 0x50 && buf[p+8 ] == 0x45 && buf[p+9 ] == 0x32 &&
                buf[p+10] == 0x2e && buf[p+11] == 0x30 &&
                // Sub-block
                buf[p+12] == 0x03 && buf[p+13] == 0x01 && buf[p+16] == 0) {
              p += 14;
              loop_count = buf[p++] | buf[p++] << 8;
              p++;  // Skip terminator.
            } else {  // We don't know what it is, just try to get past it.
              p += 12;
              while (true) {  // Seek through subblocks.
                var block_size = buf[p++];
                // Bad block size (ex: undefined from an out of bounds read).
                if (!(block_size >= 0)) throw Error("Invalid block size");
                if (block_size === 0) break;  // 0 size is terminator
                p += block_size;
              }
            }
            break;

          case 0xf9:  // Graphics Control Extension
            if (buf[p++] !== 0x4 || buf[p+4] !== 0)
              throw new Error("Invalid graphics extension block.");
            var pf1 = buf[p++];
            delay = buf[p++] | buf[p++] << 8;
            transparent_index = buf[p++];
            if ((pf1 & 1) === 0) transparent_index = null;
            disposal = pf1 >> 2 & 0x7;
            p++;  // Skip terminator.
            break;

          // Plain Text Extension could be present and we just want to be able
          // to parse past it.  It follows the block structure of the comment
          // extension enough to reuse the path to skip through the blocks.
          case 0x01:  // Plain Text Extension (fallthrough to Comment Extension)
          case 0xfe:  // Comment Extension.
            while (true) {  // Seek through subblocks.
              var block_size = buf[p++];
              // Bad block size (ex: undefined from an out of bounds read).
              if (!(block_size >= 0)) throw Error("Invalid block size");
              if (block_size === 0) break;  // 0 size is terminator
              // console.log(buf.slice(p, p+block_size).toString('ascii'));
              p += block_size;
            }
            break;

          default:
            throw new Error(
                "Unknown graphic control label: 0x" + buf[p-1].toString(16));
        }
        break;

      case 0x2c:  // Image Descriptor.
        var x = buf[p++] | buf[p++] << 8;
        var y = buf[p++] | buf[p++] << 8;
        var w = buf[p++] | buf[p++] << 8;
        var h = buf[p++] | buf[p++] << 8;
        var pf2 = buf[p++];
        var local_palette_flag = pf2 >> 7;
        var interlace_flag = pf2 >> 6 & 1;
        var num_local_colors_pow2 = pf2 & 0x7;
        var num_local_colors = 1 << (num_local_colors_pow2 + 1);
        var palette_offset = global_palette_offset;
        var palette_size = global_palette_size;
        var has_local_palette = false;
        if (local_palette_flag) {
          var has_local_palette = true;
          palette_offset = p;  // Override with local palette.
          palette_size = num_local_colors;
          p += num_local_colors * 3;  // Seek past palette.
        }

        var data_offset = p;

        p++;  // codesize
        while (true) {
          var block_size = buf[p++];
          // Bad block size (ex: undefined from an out of bounds read).
          if (!(block_size >= 0)) throw Error("Invalid block size");
          if (block_size === 0) break;  // 0 size is terminator
          p += block_size;
        }

        frames.push({x: x, y: y, width: w, height: h,
                     has_local_palette: has_local_palette,
                     palette_offset: palette_offset,
                     palette_size: palette_size,
                     data_offset: data_offset,
                     data_length: p - data_offset,
                     transparent_index: transparent_index,
                     interlaced: !!interlace_flag,
                     delay: delay,
                     disposal: disposal});
        break;

      case 0x3b:  // Trailer Marker (end of file).
        no_eof = false;
        break;

      default:
        throw new Error("Unknown gif block: 0x" + buf[p-1].toString(16));
        break;
    }
  }

  this.numFrames = function() {
    return frames.length;
  };

  this.loopCount = function() {
    return loop_count;
  };

  this.frameInfo = function(frame_num) {
    if (frame_num < 0 || frame_num >= frames.length)
      throw new Error("Frame index out of range.");
    return frames[frame_num];
  };

  this.decodeAndBlitFrameBGRA = function(frame_num, pixels) {
    var frame = this.frameInfo(frame_num);
    var num_pixels = frame.width * frame.height;
    var index_stream = new Uint8Array(num_pixels);  // At most 8-bit indices.
    GifReaderLZWOutputIndexStream(
        buf, frame.data_offset, index_stream, num_pixels);
    var palette_offset = frame.palette_offset;

    // NOTE(deanm): It seems to be much faster to compare index to 256 than
    // to === null.  Not sure why, but CompareStub_EQ_STRICT shows up high in
    // the profile, not sure if it's related to using a Uint8Array.
    var trans = frame.transparent_index;
    if (trans === null) trans = 256;

    // We are possibly just blitting to a portion of the entire frame.
    // That is a subrect within the framerect, so the additional pixels
    // must be skipped over after we finished a scanline.
    var framewidth  = frame.width;
    var framestride = width - framewidth;
    var xleft       = framewidth;  // Number of subrect pixels left in scanline.

    // Output index of the top left corner of the subrect.
    var opbeg = ((frame.y * width) + frame.x) * 4;
    // Output index of what would be the left edge of the subrect, one row
    // below it, i.e. the index at which an interlace pass should wrap.
    var opend = ((frame.y + frame.height) * width + frame.x) * 4;
    var op    = opbeg;

    var scanstride = framestride * 4;

    // Use scanstride to skip past the rows when interlacing.  This is skipping
    // 7 rows for the first two passes, then 3 then 1.
    if (frame.interlaced === true) {
      scanstride += width * 4 * 7;  // Pass 1.
    }

    var interlaceskip = 8;  // Tracking the row interval in the current pass.

    for (var i = 0, il = index_stream.length; i < il; ++i) {
      var index = index_stream[i];

      if (xleft === 0) {  // Beginning of new scan line
        op += scanstride;
        xleft = framewidth;
        if (op >= opend) { // Catch the wrap to switch passes when interlacing.
          scanstride = framestride * 4 + width * 4 * (interlaceskip-1);
          // interlaceskip / 2 * 4 is interlaceskip << 1.
          op = opbeg + (framewidth + framestride) * (interlaceskip << 1);
          interlaceskip >>= 1;
        }
      }

      if (index === trans) {
        op += 4;
      } else {
        var r = buf[palette_offset + index * 3];
        var g = buf[palette_offset + index * 3 + 1];
        var b = buf[palette_offset + index * 3 + 2];
        pixels[op++] = b;
        pixels[op++] = g;
        pixels[op++] = r;
        pixels[op++] = 255;
      }
      --xleft;
    }
  };

  // I will go to copy and paste hell one day...
  this.decodeAndBlitFrameRGBA = function(frame_num, pixels) {
    var frame = this.frameInfo(frame_num);
    var num_pixels = frame.width * frame.height;
    var index_stream = new Uint8Array(num_pixels);  // At most 8-bit indices.
    GifReaderLZWOutputIndexStream(
        buf, frame.data_offset, index_stream, num_pixels);
    var palette_offset = frame.palette_offset;

    // NOTE(deanm): It seems to be much faster to compare index to 256 than
    // to === null.  Not sure why, but CompareStub_EQ_STRICT shows up high in
    // the profile, not sure if it's related to using a Uint8Array.
    var trans = frame.transparent_index;
    if (trans === null) trans = 256;

    // We are possibly just blitting to a portion of the entire frame.
    // That is a subrect within the framerect, so the additional pixels
    // must be skipped over after we finished a scanline.
    var framewidth  = frame.width;
    var framestride = width - framewidth;
    var xleft       = framewidth;  // Number of subrect pixels left in scanline.

    // Output index of the top left corner of the subrect.
    var opbeg = ((frame.y * width) + frame.x) * 4;
    // Output index of what would be the left edge of the subrect, one row
    // below it, i.e. the index at which an interlace pass should wrap.
    var opend = ((frame.y + frame.height) * width + frame.x) * 4;
    var op    = opbeg;

    var scanstride = framestride * 4;

    // Use scanstride to skip past the rows when interlacing.  This is skipping
    // 7 rows for the first two passes, then 3 then 1.
    if (frame.interlaced === true) {
      scanstride += width * 4 * 7;  // Pass 1.
    }

    var interlaceskip = 8;  // Tracking the row interval in the current pass.

    for (var i = 0, il = index_stream.length; i < il; ++i) {
      var index = index_stream[i];

      if (xleft === 0) {  // Beginning of new scan line
        op += scanstride;
        xleft = framewidth;
        if (op >= opend) { // Catch the wrap to switch passes when interlacing.
          scanstride = framestride * 4 + width * 4 * (interlaceskip-1);
          // interlaceskip / 2 * 4 is interlaceskip << 1.
          op = opbeg + (framewidth + framestride) * (interlaceskip << 1);
          interlaceskip >>= 1;
        }
      }

      if (index === trans) {
        op += 4;
      } else {
        var r = buf[palette_offset + index * 3];
        var g = buf[palette_offset + index * 3 + 1];
        var b = buf[palette_offset + index * 3 + 2];
        pixels[op++] = r;
        pixels[op++] = g;
        pixels[op++] = b;
        pixels[op++] = 255;
      }
      --xleft;
    }
  };
}

function GifReaderLZWOutputIndexStream(code_stream, p, output, output_length) {
  var min_code_size = code_stream[p++];

  var clear_code = 1 << min_code_size;
  var eoi_code = clear_code + 1;
  var next_code = eoi_code + 1;

  var cur_code_size = min_code_size + 1;  // Number of bits per code.
  // NOTE: This shares the same name as the encoder, but has a different
  // meaning here.  Here this masks each code coming from the code stream.
  var code_mask = (1 << cur_code_size) - 1;
  var cur_shift = 0;
  var cur = 0;

  var op = 0;  // Output pointer.

  var subblock_size = code_stream[p++];

  // TODO(deanm): Would using a TypedArray be any faster?  At least it would
  // solve the fast mode / backing store uncertainty.
  // var code_table = Array(4096);
  var code_table = new Int32Array(4096);  // Can be signed, we only use 20 bits.

  var prev_code = null;  // Track code-1.

  while (true) {
    // Read up to two bytes, making sure we always 12-bits for max sized code.
    while (cur_shift < 16) {
      if (subblock_size === 0) break;  // No more data to be read.

      cur |= code_stream[p++] << cur_shift;
      cur_shift += 8;

      if (subblock_size === 1) {  // Never let it get to 0 to hold logic above.
        subblock_size = code_stream[p++];  // Next subblock.
      } else {
        --subblock_size;
      }
    }

    // TODO(deanm): We should never really get here, we should have received
    // and EOI.
    if (cur_shift < cur_code_size)
      break;

    var code = cur & code_mask;
    cur >>= cur_code_size;
    cur_shift -= cur_code_size;

    // TODO(deanm): Maybe should check that the first code was a clear code,
    // at least this is what you're supposed to do.  But actually our encoder
    // now doesn't emit a clear code first anyway.
    if (code === clear_code) {
      // We don't actually have to clear the table.  This could be a good idea
      // for greater error checking, but we don't really do any anyway.  We
      // will just track it with next_code and overwrite old entries.

      next_code = eoi_code + 1;
      cur_code_size = min_code_size + 1;
      code_mask = (1 << cur_code_size) - 1;

      // Don't update prev_code ?
      prev_code = null;
      continue;
    } else if (code === eoi_code) {
      break;
    }

    // We have a similar situation as the decoder, where we want to store
    // variable length entries (code table entries), but we want to do in a
    // faster manner than an array of arrays.  The code below stores sort of a
    // linked list within the code table, and then "chases" through it to
    // construct the dictionary entries.  When a new entry is created, just the
    // last byte is stored, and the rest (prefix) of the entry is only
    // referenced by its table entry.  Then the code chases through the
    // prefixes until it reaches a single byte code.  We have to chase twice,
    // first to compute the length, and then to actually copy the data to the
    // output (backwards, since we know the length).  The alternative would be
    // storing something in an intermediate stack, but that doesn't make any
    // more sense.  I implemented an approach where it also stored the length
    // in the code table, although it's a bit tricky because you run out of
    // bits (12 + 12 + 8), but I didn't measure much improvements (the table
    // entries are generally not the long).  Even when I created benchmarks for
    // very long table entries the complexity did not seem worth it.
    // The code table stores the prefix entry in 12 bits and then the suffix
    // byte in 8 bits, so each entry is 20 bits.

    var chase_code = code < next_code ? code : prev_code;

    // Chase what we will output, either {CODE} or {CODE-1}.
    var chase_length = 0;
    var chase = chase_code;
    while (chase > clear_code) {
      chase = code_table[chase] >> 8;
      ++chase_length;
    }

    var k = chase;

    var op_end = op + chase_length + (chase_code !== code ? 1 : 0);
    if (op_end > output_length) {
      console.log("Warning, gif stream longer than expected.");
      return;
    }

    // Already have the first byte from the chase, might as well write it fast.
    output[op++] = k;

    op += chase_length;
    var b = op;  // Track pointer, writing backwards.

    if (chase_code !== code)  // The case of emitting {CODE-1} + k.
      output[op++] = k;

    chase = chase_code;
    while (chase_length--) {
      chase = code_table[chase];
      output[--b] = chase & 0xff;  // Write backwards.
      chase >>= 8;  // Pull down to the prefix code.
    }

    if (prev_code !== null && next_code < 4096) {
      code_table[next_code++] = prev_code << 8 | k;
      // TODO(deanm): Figure out this clearing vs code growth logic better.  I
      // have an feeling that it should just happen somewhere else, for now it
      // is awkward between when we grow past the max and then hit a clear code.
      // For now just check if we hit the max 12-bits (then a clear code should
      // follow, also of course encoded in 12-bits).
      if (next_code >= code_mask+1 && cur_code_size < 12) {
        ++cur_code_size;
        code_mask = code_mask << 1 | 1;
      }
    }

    prev_code = code;
  }

  if (op !== output_length) {
    console.log("Warning, gif stream shorter than expected.");
  }

  return output;
}

// ---------------------------------------------------------------------------
// Streaming / incremental GIF decoding.
//
// GifStreamReader is a push-based counterpart to GifReader: instead of
// requiring the entire GIF file in memory up front, bytes are fed in chunks
// (for example as they arrive from the network or are read from disk).
// Header parsing, LZW decompression and canvas compositing all advance
// incrementally, frame by frame.  Only unconsumed input bytes are retained,
// so peak memory stays bounded by the canvas, one frame's pixel indices and
// the LZW dictionary -- independent of the total file size.
//
// Usage:
//   var reader = new GifStreamReader();
//   reader.onheader = function(header) { ... };   // width/height/palette
//   reader.onframe = function(frame, frame_pixels, canvas) { ... };
//   reader.onend = function() { ... };
//   reader.push(chunk);  // Uint8Array (or Buffer), as data becomes available
//   reader.finish();     // Signal end of input.
//
// onframe is called once per frame after it has been fully decoded.
// |frame_pixels| holds the frame blitted onto a transparent canvas-sized
// buffer, byte-for-byte identical to what GifReader's
// decodeAndBlitFrameRGBA() produces into a zeroed buffer (or
// decodeAndBlitFrameBGRA() when constructed with {format: 'bgra'}).
// |canvas| is the running animation composite with frame disposal applied
// (disposal 2 restores to transparent, as browsers do).  Both pixel buffers
// are owned by the reader and reused between frames, so copy them if they
// need to be retained.  |frame| carries the same per-frame fields as
// GifReader's frameInfo() (plus an |index| and the resolved |palette|).
//
// Errors are delivered to onerror if assigned, otherwise thrown from push().

// Incremental LZW decoder.  Decodes the GIF LZW code stream (including its
// sub-block framing) byte by byte into |output|, producing exactly the same
// index stream as GifReaderLZWOutputIndexStream.  run() consumes as much of
// [p, stream_end) as it can and returns the new position; the |done| flag is
// set once the image data (through the sub-block terminator) is finished.
function GifStreamLZWDecoder(output) {
  this.output = output;
  this.output_length = output.length;
  this.op = 0;
  this.done = false;
  this.overflow = false;
  this.phase = 0;  // 0: min code size, 1: code stream, 2: drain sub-blocks.
  this.subblock_size = -1;  // -1: the next byte is a sub-block size.
  this.code_table = null;
}

GifStreamLZWDecoder.prototype.run = function(stream, p, stream_end) {
  while (true) {
    if (this.phase === 0) {  // Read the minimum code size byte.
      if (p >= stream_end) return p;
      var min_code_size = stream[p++];
      this.min_code_size = min_code_size;
      this.clear_code = 1 << min_code_size;
      this.eoi_code = this.clear_code + 1;
      this.next_code = this.eoi_code + 1;
      this.cur_code_size = min_code_size + 1;
      this.code_mask = (1 << this.cur_code_size) - 1;
      this.cur_shift = 0;
      this.cur = 0;
      this.prev_code = null;
      this.code_table = new Int32Array(4096);  // 12-bit prefix + 8-bit suffix.
      this.phase = 1;
      continue;
    }

    if (this.phase === 2) {  // Drain any remaining sub-blocks after EOI.
      while (true) {
        if (this.subblock_size === 0) {  // Terminator consumed, fully done.
          if (!this.overflow && this.op !== this.output_length)
            console.log("Warning, gif stream shorter than expected.");
          this.done = true;
          return p;
        }
        if (this.subblock_size === -1) {
          if (p >= stream_end) return p;
          this.subblock_size = stream[p++];
          continue;
        }
        if (p >= stream_end) return p;
        var skip = this.subblock_size < (stream_end - p) ?
            this.subblock_size : stream_end - p;
        p += skip;
        this.subblock_size -= skip;
        if (this.subblock_size === 0) this.subblock_size = -1;
      }
    }

    // Phase 1: decode codes.  Fill the bit buffer with the same discipline
    // as GifReaderLZWOutputIndexStream (always hold up to 16 bits).
    while (this.cur_shift < 16) {
      if (this.subblock_size === 0) break;  // Terminator reached.
      if (this.subblock_size === -1) {
        if (p >= stream_end) return p;
        this.subblock_size = stream[p++];
        continue;
      }
      if (p >= stream_end) return p;
      this.cur |= stream[p++] << this.cur_shift;
      this.cur_shift += 8;
      if (--this.subblock_size === 0) this.subblock_size = -1;
    }

    if (this.cur_shift < this.cur_code_size) {
      // Ran out of input bits at the terminator, the same end condition as
      // the whole-file decoder running out of sub-block data.
      if (!this.overflow && this.op !== this.output_length)
        console.log("Warning, gif stream shorter than expected.");
      this.done = true;
      return p;
    }

    var code = this.cur & this.code_mask;
    this.cur >>= this.cur_code_size;
    this.cur_shift -= this.cur_code_size;

    if (code === this.clear_code) {
      this.next_code = this.eoi_code + 1;
      this.cur_code_size = this.min_code_size + 1;
      this.code_mask = (1 << this.cur_code_size) - 1;
      this.prev_code = null;
      continue;
    }

    if (code === this.eoi_code) {
      this.phase = 2;  // Consume the rest of the sub-block chain.
      continue;
    }

    // See GifReaderLZWOutputIndexStream for an explanation of the code table
    // (12-bit prefix code + 8-bit suffix byte per entry) and the chasing.
    var chase_code = code < this.next_code ? code : this.prev_code;

    var chase_length = 0;
    var chase = chase_code;
    var code_table = this.code_table;
    while (chase > this.clear_code) {
      chase = code_table[chase] >> 8;
      ++chase_length;
    }

    var k = chase;
    var op = this.op;
    var op_end = op + chase_length + (chase_code !== code ? 1 : 0);
    if (op_end > this.output_length) {
      console.log("Warning, gif stream longer than expected.");
      this.overflow = true;
      this.phase = 2;
      continue;
    }

    var output = this.output;
    output[op++] = k;

    op += chase_length;
    var b = op;  // Track pointer, writing backwards.

    if (chase_code !== code)  // The case of emitting {CODE-1} + k.
      output[op++] = k;

    chase = chase_code;
    while (chase_length--) {
      chase = code_table[chase];
      output[--b] = chase & 0xff;  // Write backwards.
      chase >>= 8;  // Pull down to the prefix code.
    }
    this.op = op;

    if (this.prev_code !== null && this.next_code < 4096) {
      code_table[this.next_code++] = this.prev_code << 8 | k;
      if (this.next_code >= this.code_mask + 1 && this.cur_code_size < 12) {
        ++this.cur_code_size;
        this.code_mask = this.code_mask << 1 | 1;
      }
    }

    this.prev_code = code;
  }
};

function GifStreamReader(opts) {
  opts = opts === undefined ? { } : opts;
  var bgra = opts.format === 'bgra';

  var self = this;

  // Event handlers, assign as needed (see the documentation above).
  this.onheader = null;
  this.onframe = null;
  this.onend = null;
  this.onerror = null;

  this.width = 0;
  this.height = 0;
  this.loopCount = null;  // null until a Netscape looping block is seen.
  this.framesDecoded = 0;

  // Parser states.
  var ST_HEADER = 0, ST_LSD = 1, ST_GCT = 2, ST_BLOCK = 3, ST_EXT = 4,
      ST_GCE = 5, ST_APP = 6, ST_APP_DATA = 7, ST_SKIP_SUBBLOCKS = 8,
      ST_IMG_DESC = 9, ST_LCT = 10, ST_IMG_DATA = 11, ST_END = 12;

  // Input buffer.  Only bytes not yet consumed are retained, so this stays
  // on the order of the pushed chunk size regardless of the file size.
  var ibuf = new Uint8Array(1 << 16);
  var ipos = 0;
  var iend = 0;

  var state = ST_HEADER;

  // Logical screen.
  var width = 0;
  var height = 0;
  var background = 0;
  var global_palette = null;  // Uint8Array of RGB triplets (a private copy).
  var gct_size = 0;

  // Graphics control state.  Sticky until replaced by another Graphics
  // Control Extension, matching GifReader's behavior.
  var delay = 0;
  var transparent_index = null;
  var disposal = 0;

  // Current frame.
  var frame = null;
  var frame_palette = null;
  var lct_size = 0;
  var index_stream = null;
  var lzw = null;

  // Output buffers (allocated from the header, reused between frames).
  var canvas = null;        // Animation composite (disposal applied).
  var frame_pixels = null;  // Raw per-frame blit.
  var prev_rect = null;     // Rect + disposal of the previously composited frame.
  var saved_rect = null;    // Saved canvas contents for disposal 3.
  var saved_rect_dims = null;

  var end_fired = false;

  function fire_header() {
    if (self.onheader !== null) {
      self.onheader({width: width, height: height, background: background,
                     globalPalette: global_palette});
    }
  }

  function fire_end() {
    if (end_fired) return;
    end_fired = true;
    if (self.onend !== null) self.onend();
  }

  // Blit the current frame into |out| (canvas-sized RGBA/BGRA).  Mirrors
  // GifReader's decodeAndBlitFrameRGBA/BGRA exactly (including interlacing),
  // except the palette is read from a private copy rather than the file.
  function blit_frame(out) {
    var num_pixels = frame.width * frame.height;
    var palette = frame_palette;

    var trans = frame.transparent_index;
    if (trans === null) trans = 256;

    // Subrect within the canvas, skip the remaining pixels after a scanline.
    var framewidth  = frame.width;
    var framestride = width - framewidth;
    var xleft       = framewidth;

    var opbeg = ((frame.y * width) + frame.x) * 4;
    var opend = ((frame.y + frame.height) * width + frame.x) * 4;
    var op    = opbeg;

    var scanstride = framestride * 4;
    if (frame.interlaced === true) {
      scanstride += width * 4 * 7;  // Pass 1.
    }
    var interlaceskip = 8;

    for (var i = 0; i < num_pixels; ++i) {
      var index = index_stream[i];

      if (xleft === 0) {  // Beginning of new scan line.
        op += scanstride;
        xleft = framewidth;
        if (op >= opend) {  // Wrap to switch passes when interlacing.
          scanstride = framestride * 4 + width * 4 * (interlaceskip-1);
          op = opbeg + (framewidth + framestride) * (interlaceskip << 1);
          interlaceskip >>= 1;
        }
      }

      if (index === trans || palette === null) {
        op += 4;
      } else {
        var r = palette[index * 3];
        var g = palette[index * 3 + 1];
        var b = palette[index * 3 + 2];
        if (bgra) {
          out[op++] = b; out[op++] = g; out[op++] = r;
        } else {
          out[op++] = r; out[op++] = g; out[op++] = b;
        }
        out[op++] = 255;
      }
      --xleft;
    }
  }

  function clear_canvas_rect(rect) {  // Disposal 2: restore to transparent.
    var x1 = Math.min(rect.x + rect.width, width);
    var y1 = Math.min(rect.y + rect.height, height);
    for (var row = rect.y; row < y1; ++row) {
      var o = (row * width + rect.x) * 4;
      canvas.fill(0, o, o + (x1 - rect.x) * 4);
    }
  }

  function save_canvas_rect(rect) {  // Disposal 3: snapshot before blit.
    var w = Math.min(rect.width, width - rect.x);
    var h = Math.min(rect.height, height - rect.y);
    if (w <= 0 || h <= 0) { saved_rect_dims = null; return; }
    saved_rect = new Uint8Array(w * h * 4);
    for (var row = 0; row < h; ++row) {
      var o = ((rect.y + row) * width + rect.x) * 4;
      saved_rect.set(canvas.subarray(o, o + w * 4), row * w * 4);
    }
    saved_rect_dims = {x: rect.x, y: rect.y, width: w, height: h};
  }

  function restore_canvas_rect() {
    var d = saved_rect_dims;
    for (var row = 0; row < d.height; ++row) {
      canvas.set(saved_rect.subarray(row * d.width * 4, (row+1) * d.width * 4),
                 ((d.y + row) * width + d.x) * 4);
    }
  }

  function finish_frame() {
    // Raw per-frame blit, identical to decodeAndBlitFrameRGBA/BGRA into a
    // freshly zeroed buffer.
    frame_pixels.fill(0);
    blit_frame(frame_pixels);

    // Composite onto the animation canvas, applying the previous frame's
    // disposal method first.
    if (prev_rect !== null) {
      if (prev_rect.disposal === 2) {
        clear_canvas_rect(prev_rect);
      } else if (prev_rect.disposal === 3 && saved_rect_dims !== null) {
        restore_canvas_rect();
      }
    }
    if (frame.disposal === 3) save_canvas_rect(frame);
    blit_frame(canvas);
    prev_rect = {x: frame.x, y: frame.y, width: frame.width,
                 height: frame.height, disposal: frame.disposal};

    ++self.framesDecoded;
    var f = frame;
    // Release per-frame decode state before invoking the callback.
    frame = null; frame_palette = null; index_stream = null; lzw = null;
    if (self.onframe !== null) self.onframe(f, frame_pixels, canvas);
  }

  function start_image_data() {
    frame.palette = frame_palette;
    index_stream = new Uint8Array(frame.width * frame.height);
    lzw = new GifStreamLZWDecoder(index_stream);
    state = ST_IMG_DATA;
  }

  function parse() {
    while (state !== ST_END) {
      var avail = iend - ipos;
      switch (state) {
        case ST_HEADER: {  // GIF87a or GIF89a.
          if (avail < 6) return;
          if (ibuf[ipos  ] !== 0x47 || ibuf[ipos+1] !== 0x49 ||
              ibuf[ipos+2] !== 0x46 || ibuf[ipos+3] !== 0x38 ||
              (ibuf[ipos+4]+1 & 0xfd) !== 0x38 || ibuf[ipos+5] !== 0x61) {
            throw new Error("Invalid GIF 87a/89a header.");
          }
          ipos += 6;
          state = ST_LSD;
          break;
        }

        case ST_LSD: {  // Logical Screen Descriptor.
          if (avail < 7) return;
          width = ibuf[ipos] | ibuf[ipos+1] << 8;
          height = ibuf[ipos+2] | ibuf[ipos+3] << 8;
          var pf0 = ibuf[ipos+4];
          background = ibuf[ipos+5];
          ipos += 7;
          self.width = width;
          self.height = height;
          canvas = new Uint8Array(width * height * 4);
          frame_pixels = new Uint8Array(width * height * 4);
          if (pf0 >> 7) {  // Global Color Table Flag.
            gct_size = 3 * (1 << ((pf0 & 0x7) + 1));
            state = ST_GCT;
          } else {
            fire_header();
            state = ST_BLOCK;
          }
          break;
        }

        case ST_GCT: {  // Global Color Table.
          if (avail < gct_size) return;
          global_palette = ibuf.slice(ipos, ipos + gct_size);
          ipos += gct_size;
          fire_header();
          state = ST_BLOCK;
          break;
        }

        case ST_BLOCK: {  // Block introducer.
          if (avail < 1) return;
          var introducer = ibuf[ipos++];
          if (introducer === 0x21) {  // Extension.
            state = ST_EXT;
          } else if (introducer === 0x2c) {  // Image Descriptor.
            state = ST_IMG_DESC;
          } else if (introducer === 0x3b) {  // Trailer Marker.
            state = ST_END;
          } else {
            throw new Error("Unknown gif block: 0x" + introducer.toString(16));
          }
          break;
        }

        case ST_EXT: {  // Extension label.
          if (avail < 1) return;
          var label = ibuf[ipos++];
          if (label === 0xf9) {  // Graphics Control Extension.
            state = ST_GCE;
          } else if (label === 0xff) {  // Application Extension.
            state = ST_APP;
          } else if (label === 0xfe || label === 0x01) {  // Comment/Plain Text.
            state = ST_SKIP_SUBBLOCKS;
          } else {
            throw new Error(
                "Unknown graphic control label: 0x" + label.toString(16));
          }
          break;
        }

        case ST_GCE: {  // Graphics Control Extension.
          if (avail < 6) return;
          if (ibuf[ipos] !== 0x4 || ibuf[ipos+5] !== 0)
            throw new Error("Invalid graphics extension block.");
          var pf1 = ibuf[ipos+1];
          delay = ibuf[ipos+2] | ibuf[ipos+3] << 8;
          transparent_index = ibuf[ipos+4];
          if ((pf1 & 1) === 0) transparent_index = null;
          disposal = pf1 >> 2 & 0x7;
          ipos += 6;
          state = ST_BLOCK;
          break;
        }

        case ST_APP: {  // Application Extension identifier.
          if (avail < 12) return;
          // Check for a Netscape looping extension ("NETSCAPE2.0").
          if (ibuf[ipos   ] === 0x0b &&
              ibuf[ipos+1 ] === 0x4e && ibuf[ipos+2 ] === 0x45 &&
              ibuf[ipos+3 ] === 0x54 && ibuf[ipos+4 ] === 0x53 &&
              ibuf[ipos+5 ] === 0x43 && ibuf[ipos+6 ] === 0x41 &&
              ibuf[ipos+7 ] === 0x50 && ibuf[ipos+8 ] === 0x45 &&
              ibuf[ipos+9 ] === 0x32 && ibuf[ipos+10] === 0x2e &&
              ibuf[ipos+11] === 0x30) {
            state = ST_APP_DATA;  // Expect 03 01 <loop lo> <loop hi> 00.
          } else {  // Unknown application, skip its sub-blocks.
            ipos += 12;
            state = ST_SKIP_SUBBLOCKS;
          }
          break;
        }

        case ST_APP_DATA: {  // Netscape looping sub-block.
          if (avail < 17) return;
          if (ibuf[ipos+12] === 0x03 && ibuf[ipos+13] === 0x01 &&
              ibuf[ipos+16] === 0x00) {
            self.loopCount = ibuf[ipos+14] | ibuf[ipos+15] << 8;
            ipos += 17;
            state = ST_BLOCK;
          } else {  // Not the expected sub-block, skip like an unknown app.
            ipos += 12;
            state = ST_SKIP_SUBBLOCKS;
          }
          break;
        }

        case ST_SKIP_SUBBLOCKS: {  // Skip a chain of data sub-blocks.
          while (true) {
            if (iend - ipos < 1) return;
            var block_size = ibuf[ipos];
            if (block_size === 0) {  // 0 size is the terminator.
              ++ipos;
              state = ST_BLOCK;
              break;
            }
            if (iend - ipos < 1 + block_size) return;
            ipos += 1 + block_size;
          }
          break;
        }

        case ST_IMG_DESC: {  // Image Descriptor.
          if (avail < 9) return;
          var fx = ibuf[ipos  ] | ibuf[ipos+1] << 8;
          var fy = ibuf[ipos+2] | ibuf[ipos+3] << 8;
          var fw = ibuf[ipos+4] | ibuf[ipos+5] << 8;
          var fh = ibuf[ipos+6] | ibuf[ipos+7] << 8;
          var pf2 = ibuf[ipos+8];
          ipos += 9;
          frame = {index: self.framesDecoded,
                   x: fx, y: fy, width: fw, height: fh,
                   has_local_palette: (pf2 >> 7) !== 0,
                   transparent_index: transparent_index,
                   interlaced: (pf2 >> 6 & 1) !== 0,
                   delay: delay,
                   disposal: disposal};
          if (frame.has_local_palette) {
            lct_size = 3 * (1 << ((pf2 & 0x7) + 1));
            state = ST_LCT;
          } else {
            frame_palette = global_palette;
            start_image_data();
          }
          break;
        }

        case ST_LCT: {  // Local Color Table.
          if (avail < lct_size) return;
          frame_palette = ibuf.slice(ipos, ipos + lct_size);
          ipos += lct_size;
          start_image_data();
          break;
        }

        case ST_IMG_DATA: {  // LZW code stream (sub-block framed).
          ipos = lzw.run(ibuf, ipos, iend);
          if (lzw.done !== true) return;  // Need more input.
          finish_frame();
          state = ST_BLOCK;
          break;
        }
      }
    }
    fire_end();
  }

  // Feed the next chunk of GIF data (a Uint8Array or Buffer).
  this.push = function(chunk) {
    if (state === ST_END || chunk.length === 0) return;
    // Compact consumed bytes and make room for the new chunk.
    if (ipos > 0) {
      ibuf.copyWithin(0, ipos, iend);
      iend -= ipos;
      ipos = 0;
    }
    if (iend + chunk.length > ibuf.length) {
      var capacity = ibuf.length * 2;
      if (capacity < iend + chunk.length) capacity = iend + chunk.length;
      var nbuf = new Uint8Array(capacity);
      nbuf.set(ibuf.subarray(0, iend), 0);
      ibuf = nbuf;
    }
    ibuf.set(chunk, iend);
    iend += chunk.length;
    try {
      parse();
    } catch (e) {
      if (self.onerror !== null) { self.onerror(e); return; }
      throw e;
    }
    if (ipos === iend) ipos = iend = 0;  // Fully consumed, reset.
  };

  // Signal that no more input will be pushed.
  this.finish = function() {
    if (end_fired) return;
    if (state !== ST_END && state !== ST_BLOCK) {
      var err = new Error("Truncated GIF file.");
      if (self.onerror !== null) { self.onerror(err); return; }
      throw err;
    }
    fire_end();
  };
}

// CommonJS.
try {
  exports.GifWriter = GifWriter;
  exports.GifReader = GifReader;
  exports.GifStreamReader = GifStreamReader;
} catch(e) {}
