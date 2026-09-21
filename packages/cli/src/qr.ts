/**
 * A QR code for the authorize link, drawn in the terminal.
 *
 * The case it is for is the normal one: the account owner is NOT at the machine
 * running the agent. Opening a browser here helps them not at all, and a
 * 115-character URL is not something anyone retypes. A code they scan with the
 * phone their wallet is already on is the shortest path between "the agent has
 * an address" and "the owner has signed".
 *
 * ## Where it came from
 *
 * Ported from the perp agent (`WaterXProtocol/waterx-agent`, `src/cli/qr.ts`),
 * which is the same organisation and the same licence, together with its
 * reference fixtures and its tests. Rewriting it here would have risked exactly
 * the two bugs its header records — a reversed generator polynomial and a
 * transposed format block, both of which still produce something that looks
 * like a QR code — for no benefit over code that is already checked against an
 * independent implementation.
 *
 * ## Why this is written out rather than installed
 *
 * This package has three runtime dependencies and argues for each. A QR encoder
 * is a few hundred lines of well-specified arithmetic (ISO/IEC 18004) with no
 * I/O and no reason to change; a dependency for it would be a supply-chain
 * surface added to a program that signs transactions against real money, in
 * exchange for convenience. So it is here, and it is checked against an
 * independent implementation: `test/fixtures/qr.json` holds reference matrices
 * generated once from the npm `qrcode` package, and the tests compare module
 * for module. Nothing in this file is trusted because it looks right.
 *
 * Two bugs it was wrong with before that comparison passed, both of which still
 * produced something that looked exactly like a QR code: the generator
 * polynomial came out reversed, so it was not monic and every division after it
 * was wrong; and the two copies of the format block were written transposed,
 * which only shows up in the four bit positions where the orders disagree. The
 * rendered codes were also fed to an independent DECODER once, during
 * development, and came back byte-identical — not kept as a test, because it
 * would mean a dependency for one assertion.
 *
 * Scope is deliberately narrow: byte mode, error correction level M, versions 1
 * to 10. That covers 213 bytes -- an authorize link is about 115 -- and
 * anything longer gets no code and the link it already had.
 */

/**
 * Per version, at level M: the symbol's total codewords, how many of those are
 * error correction, how many blocks they are split into, and where the
 * alignment patterns go.
 *
 * Read from ISO/IEC 18004 via the reference implementation rather than typed
 * from memory -- see `test/fixtures/qr.json`, which carries the same numbers
 * and the matrices they produce.
 */
const VERSIONS: Readonly<
  Record<number, { total: number; ec: number; blocks: number; align: number[] }>
> = {
  1: { total: 26, ec: 10, blocks: 1, align: [] },
  2: { total: 44, ec: 16, blocks: 1, align: [6, 18] },
  3: { total: 70, ec: 26, blocks: 1, align: [6, 22] },
  4: { total: 100, ec: 36, blocks: 2, align: [6, 26] },
  5: { total: 134, ec: 48, blocks: 2, align: [6, 30] },
  6: { total: 172, ec: 64, blocks: 4, align: [6, 34] },
  7: { total: 196, ec: 72, blocks: 4, align: [6, 22, 38] },
  8: { total: 242, ec: 88, blocks: 4, align: [6, 24, 42] },
  9: { total: 292, ec: 110, blocks: 5, align: [6, 26, 46] },
  10: { total: 346, ec: 130, blocks: 5, align: [6, 28, 50] },
};

/** Bits of padding after the last codeword, by version. */
const REMAINDER_BITS: Readonly<Record<number, number>> = {
  1: 0,
  2: 7,
  3: 7,
  4: 7,
  5: 7,
  6: 7,
  7: 0,
  8: 0,
  9: 0,
  10: 0,
};

const MAX_VERSION = 10;

export interface QrCode {
  version: number;
  /** Modules across one side, excluding the quiet zone. */
  size: number;
  /** Which of the eight masks was drawn. */
  mask: number;
  /** `true` is a dark module. Indexed `[row][column]`. */
  modules: boolean[][];
}

export interface EncodeOptions {
  /**
   * Draw this mask rather than the one scoring picks.
   *
   * For tests and for diagnosis: a symbol that matches a reference under a
   * forced mask but not under the chosen one has correct placement and a
   * scoring disagreement, which are different bugs in different functions.
   */
  mask?: number;
}

// --- GF(256), the field the error correction is computed in ------------------
// x^8 + x^4 + x^3 + x^2 + 1 = 0x11D, which is the polynomial the spec names.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] ?? 0;
}

const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0);

/** The generator polynomial for `degree` error-correction codewords. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      const coefficient = poly[j] ?? 0;
      // Index 0 is the HIGHEST degree, so multiplying by x keeps a term where
      // it is and multiplying by the root moves it down one. Swapping these two
      // produces the polynomial reversed -- degree 2 comes out [2,3,1] instead
      // of [1,3,2] -- which is not monic, so every division after it is wrong
      // while still looking like a QR code.
      next[j] = (next[j] ?? 0) ^ coefficient;
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(coefficient, EXP[i] ?? 0);
    }
    poly = next;
  }
  return poly;
}

/** The remainder of `data` divided by the generator: the error-correction codewords. */
function errorCorrection(data: number[], degree: number): number[] {
  const gen = generator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      remainder[i] = (remainder[i] ?? 0) ^ mul(gen[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}

// --- The bit stream ----------------------------------------------------------

class Bits {
  readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }
}

/** The smallest version that holds `bytes`, or `undefined` past version 10. */
function versionFor(bytes: number): number | undefined {
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const spec = VERSIONS[v];
    if (spec === undefined) continue;
    const dataBits = (spec.total - spec.ec) * 8;
    // Mode indicator, then the character count -- 8 bits of it below version 10,
    // 16 from version 10 up.
    const needed = 4 + (v < 10 ? 8 : 16) + bytes * 8;
    if (needed <= dataBits) return v;
  }
  return undefined;
}

/** Data codewords: header, bytes, terminator, padding -- in the order the spec sets. */
function codewords(data: Uint8Array, version: number): number[] {
  const spec = VERSIONS[version];
  if (spec === undefined) throw new Error(`unsupported QR version ${String(version)}`);
  const capacity = (spec.total - spec.ec) * 8;
  const stream = new Bits();
  stream.push(0b0100, 4);
  stream.push(data.length, version < 10 ? 8 : 16);
  for (const byte of data) stream.push(byte, 8);
  // A terminator of up to four zeros, then out to a byte boundary.
  stream.push(0, Math.min(4, capacity - stream.length));
  while (stream.length % 8 !== 0) stream.push(0, 1);

  const bytes: number[] = [];
  for (let i = 0; i < stream.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (stream.bits[i + j] ?? 0);
    bytes.push(byte);
  }
  // The two pad codewords the spec names, alternating, to fill the block.
  const pad = [0xec, 0x11];
  for (let i = 0; bytes.length < spec.total - spec.ec; i += 1) bytes.push(pad[i % 2] ?? 0);
  return bytes;
}

/**
 * Split into blocks, error-correct each, and interleave -- data codewords first,
 * taking one from each block in turn, then the same for the correction.
 */
function interleave(data: number[], version: number): number[] {
  const spec = VERSIONS[version];
  if (spec === undefined) throw new Error(`unsupported QR version ${String(version)}`);
  const dataTotal = spec.total - spec.ec;
  const perBlock = spec.ec / spec.blocks;
  // The spec's split: the long blocks are the last ones, one codeword longer.
  const shortLength = Math.floor(dataTotal / spec.blocks);
  const longCount = dataTotal % spec.blocks;

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (let b = 0; b < spec.blocks; b += 1) {
    const length = shortLength + (b >= spec.blocks - longCount ? 1 : 0);
    const block = data.slice(at, at + length);
    at += length;
    dataBlocks.push(block);
    ecBlocks.push(errorCorrection(block, perBlock));
  }

  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i] ?? 0);
  }
  for (let i = 0; i < perBlock; i += 1) {
    for (const block of ecBlocks) out.push(block[i] ?? 0);
  }
  return out;
}

// --- The symbol --------------------------------------------------------------

type Grid = (boolean | undefined)[][];

/** The 18-bit version block: 6 data bits and a BCH(18,6) remainder. */
function versionInfo(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) {
    remainder = (remainder << 1) ^ (remainder >> 11 !== 0 ? 0x1f25 : 0);
  }
  return ((version << 12) | remainder) & 0x3ffff;
}

/** The 15-bit format block for level M and a mask: BCH(15,5), then masked. */
function formatInfo(mask: number): number {
  const data = (0b00 << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ (remainder >> 9 !== 0 ? 0x537 : 0);
  }
  return (((data << 10) | remainder) ^ 0x5412) & 0x7fff;
}

/** Finder patterns, separators, timing, alignment, version block, dark module. */
function functionPatterns(size: number, version: number): { grid: Grid; reserved: boolean[][] } {
  const grid: Grid = Array.from({ length: size }, () =>
    new Array<boolean | undefined>(size).fill(undefined),
  );
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const set = (row: number, column: number, dark: boolean): void => {
    const gridRow = grid[row];
    const reservedRow = reserved[row];
    if (gridRow === undefined || reservedRow === undefined) return;
    if (column < 0 || column >= size) return;
    gridRow[column] = dark;
    reservedRow[column] = true;
  };

  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const row = top + r;
        const column = left + c;
        if (row < 0 || row >= size || column < 0 || column >= size) continue;
        const onRing = (r === 0 || r === 6) && c >= 0 && c <= 6;
        const onSide = (c === 0 || c === 6) && r >= 0 && r <= 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(row, column, onRing || onSide || inCore);
      }
    }
  }

  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  const centres = VERSIONS[version]?.align ?? [];
  for (const row of centres) {
    for (const column of centres) {
      const nearFinder =
        (row <= 8 && column <= 8) ||
        (row <= 8 && column >= size - 9) ||
        (row >= size - 9 && column <= 8);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          set(row + r, column + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
        }
      }
    }
  }

  // Reserved for format information, and the module that is always dark.
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      const row8 = reserved[8];
      if (row8 !== undefined) row8[i] = true;
      const rowI = reserved[i];
      if (rowI !== undefined) rowI[8] = true;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    const row8 = reserved[8];
    if (row8 !== undefined) row8[size - 1 - i] = true;
    const row = reserved[size - 1 - i];
    if (row !== undefined) row[8] = true;
  }
  set(size - 8, 8, true);

  if (version >= 7) {
    const info = versionInfo(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((info >> i) & 1) === 1;
      const row = Math.floor(i / 3);
      const column = size - 11 + (i % 3);
      set(row, column, bit);
      set(column, row, bit);
    }
  }

  return { grid, reserved };
}

const MASKS: readonly ((row: number, column: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The four penalty rules, which decide which mask a reader will find easiest. */
function penalty(modules: boolean[][], size: number): number {
  let score = 0;
  const at = (r: number, c: number): boolean => modules[r]?.[c] ?? false;

  for (let r = 0; r < size; r += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let i = 1; i < size; i += 1) {
        const previous = horizontal ? at(r, i - 1) : at(i - 1, r);
        const current = horizontal ? at(r, i) : at(i, r);
        if (current === previous) {
          run += 1;
          continue;
        }
        if (run >= 5) score += run - 2;
        run = 1;
      }
      if (run >= 5) score += run - 2;
    }
  }

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const first = at(r, c);
      if (first === at(r, c + 1) && first === at(r + 1, c) && first === at(r + 1, c + 1)) {
        score += 3;
      }
    }
  }

  const FINDER = [true, false, true, true, true, false, true];
  const matches = (cells: boolean[], start: number): boolean =>
    FINDER.every((want, i) => cells[start + i] === want);
  for (let i = 0; i < size; i += 1) {
    const row: boolean[] = [];
    const column: boolean[] = [];
    for (let j = 0; j < size; j += 1) {
      row.push(at(i, j));
      column.push(at(j, i));
    }
    for (const line of [row, column]) {
      for (let start = 0; start + 7 <= size; start += 1) {
        if (!matches(line, start)) continue;
        const before = line.slice(Math.max(0, start - 4), start);
        const after = line.slice(start + 7, start + 11);
        if (before.length === 4 && before.every((cell) => !cell)) score += 40;
        if (after.length === 4 && after.every((cell) => !cell)) score += 40;
      }
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (at(r, c)) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** The format block, written twice: around the top-left finder, and split across the other two. */
function writeFormat(modules: boolean[][], size: number, format: number): void {
  const put = (row: number, column: number, dark: boolean): void => {
    const target = modules[row];
    if (target !== undefined) target[column] = dark;
  };
  // Least significant bit first. The two copies run in opposite directions --
  // the column down from the top-left finder, the row leftwards from the
  // bottom-right -- and transposing them puts the right value in the wrong
  // places: only the bits where the two orders disagree show up, so the symbol
  // still looks like a QR code and stops scanning.
  for (let i = 0; i < 15; i += 1) {
    const dark = ((format >> i) & 1) === 1;

    // Column 8, downwards, stepping over the horizontal timing row.
    if (i < 6) put(i, 8, dark);
    else if (i < 8) put(i + 1, 8, dark);
    else put(size - 15 + i, 8, dark);

    // Row 8, leftwards from the right edge, then the tail beside the finder.
    if (i < 8) put(8, size - 1 - i, dark);
    else if (i === 8) put(8, 7, dark);
    else put(8, 14 - i, dark);
  }
  put(size - 8, 8, true);
}

/**
 * Encode `text` as a QR symbol, or `undefined` when it is longer than version 10
 * holds -- where the caller still has the link it was going to draw.
 */
export function encodeQr(text: string, options: EncodeOptions = {}): QrCode | undefined {
  const bytes = new TextEncoder().encode(text);
  const version = versionFor(bytes.length);
  if (version === undefined) return undefined;
  const size = version * 4 + 17;
  const data = interleave(codewords(bytes, version), version);

  const { grid, reserved } = functionPatterns(size, version);

  const bits: boolean[] = [];
  for (const byte of data) for (let i = 7; i >= 0; i -= 1) bits.push(((byte >> i) & 1) === 1);
  for (let i = 0; i < (REMAINDER_BITS[version] ?? 0); i += 1) bits.push(false);

  // The data path: two columns at a time, right to left, alternating direction,
  // stepping over the column the vertical timing pattern occupies.
  let bit = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    const column = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const c of [column, column - 1]) {
        if (c < 0) continue;
        if (reserved[row]?.[c] === true) continue;
        const gridRow = grid[row];
        if (gridRow === undefined) continue;
        gridRow[c] = bits[bit] ?? false;
        bit += 1;
      }
    }
    upward = !upward;
  }

  // Every mask is drawn and scored; the reader gets the easiest one.
  let best: { modules: boolean[][]; score: number; mask: number } | undefined;
  for (const [index, mask] of MASKS.entries()) {
    if (options.mask !== undefined && options.mask !== index) continue;
    const modules: boolean[][] = grid.map((row, r) =>
      row.map((cell, c) => {
        const dark = cell ?? false;
        return reserved[r]?.[c] === true ? dark : dark !== mask(r, c);
      }),
    );
    writeFormat(modules, size, formatInfo(index));
    const score = penalty(modules, size);
    if (best === undefined || score < best.score) best = { modules, score, mask: index };
  }
  if (best === undefined) return undefined;
  return { version, size, mask: best.mask, modules: best.modules };
}

// --- Drawing it --------------------------------------------------------------

export interface RenderOptions {
  /** Light modules around the symbol. Four is the minimum a reader is entitled to. */
  quiet?: number;
  /**
   * Draw with explicit colours rather than relying on the terminal's own.
   *
   * A code drawn as ink on the terminal's background is inverted on a dark
   * theme, and a reader is not obliged to cope with that. With colours, each
   * half block carries its own foreground and background, so the symbol looks
   * the same whatever the theme.
   */
  color?: boolean;
}

/** Built rather than written out: an escape in a source file is a control character. */
const ESC = String.fromCharCode(27);
const RESET = ESC + "[0m";
const LIGHT = ESC + "[37;40m";
const DARK = ESC + "[30;47m";
const UPPER_HALF = String.fromCharCode(0x2580);
const LOWER_HALF = String.fromCharCode(0x2584);
const FULL = String.fromCharCode(0x2588);

/**
 * The symbol as terminal lines, two module rows per line.
 *
 * Half blocks because a terminal cell is about twice as tall as it is wide: one
 * cell per module across, two modules per cell down, and the result is square.
 */
export function renderQr(code: QrCode, options: RenderOptions = {}): string[] {
  const quiet = options.quiet ?? 4;
  const color = options.color ?? true;
  const span = code.size + quiet * 2;
  const dark = (row: number, column: number): boolean => {
    const r = row - quiet;
    const c = column - quiet;
    if (r < 0 || c < 0 || r >= code.size || c >= code.size) return false;
    return code.modules[r]?.[c] ?? false;
  };

  const lines: string[] = [];
  for (let row = 0; row < span; row += 2) {
    let line = "";
    for (let column = 0; column < span; column += 1) {
      const top = dark(row, column);
      const bottom = row + 1 < span ? dark(row + 1, column) : false;
      if (color) {
        // Foreground is the top module, background the bottom one.
        line += (top ? DARK : LIGHT) + (bottom === top ? " " : top ? UPPER_HALF : LOWER_HALF);
      } else {
        line += top && bottom ? FULL : top ? UPPER_HALF : bottom ? LOWER_HALF : " ";
      }
    }
    lines.push(color ? line + RESET : line);
  }
  return lines;
}

/** Encode and draw in one step, or `undefined` when the text does not fit. */
export function qrLines(text: string, options: RenderOptions = {}): string[] | undefined {
  const code = encodeQr(text);
  return code === undefined ? undefined : renderQr(code, options);
}
