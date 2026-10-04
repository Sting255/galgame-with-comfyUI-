/**
 * 最小 tar(ustar) + gzip 读写实现 —— 一键导出/导入数据专用，不引入任何新依赖。
 *
 * 为什么自己写：
 *   agent-core/package.json 里没有任何 zip/tar 库（tar / archiver / adm-zip / jszip / tar-stream …），
 *   node_modules 里的 tar-stream / tar-fs 只是 sharp 的传递依赖，不是本项目的直接依赖，
 *   跟着传递依赖写生产代码随时会因上游换版本而消失。这里用 Node 内置 zlib 做 gzip，
 *   自己写 ustar 头（512 字节块 + 数据 512 对齐），读写两个方向都实现。
 *
 * 能力边界（有意保持最小）：
 *   - 只写 ustar：name 超 100 字节时按 '/' 切 prefix(≤155)/name(≤100)；不做 GNU longname / pax 扩展。
 *   - 只读 ustar + 兼容 GNU 的 base-256 size 字段；GNU 'L'/'K' 长名扩展**不支持**（本模块自己写出的
 *     归档不需要它，外部归档遇到就报错，不当成合法输入）。
 *   - 读取端把"符号链接 / 硬链接 / 设备 / FIFO"等**原样暴露给调用方**（type 字段），由上层决定拒绝；
 *     本模块不做安全策略，安全校验属于 dataBackup.js 的职责。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const BLOCK_SIZE = 512;
const NAME_FIELD = 100;
const PREFIX_FIELD = 155;

/** 普通文件（'\0' 是 POSIX 早期的普通文件写法，读取端一并接受） */
export const TYPE_FILE = '0';
export const TYPE_FILE_LEGACY = '\0';
export const TYPE_HARDLINK = '1';
export const TYPE_SYMLINK = '2';
export const TYPE_DIR = '5';

const EMPTY = Buffer.alloc(0);

// ── ustar 头字段的原语 ────────────────────────────────────────────────

function writeString(buf, offset, length, value) {
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length > length) {
    throw new Error(`tar: 头部字段超长（${bytes.length} > ${length}）: ${value}`);
  }
  bytes.copy(buf, offset);
}

function writeOctal(buf, offset, length, value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  const text = number.toString(8);
  if (text.length > length - 1) {
    throw new Error(`tar: 八进制字段溢出（${number} 装不进 ${length - 1} 位）`);
  }
  buf.write(text.padStart(length - 1, '0'), offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function readField(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

function readOctal(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  // GNU base-256：首字节最高位为 1 时是二进制大端整数（大文件 >8GB 才会用到）
  if (slice[0] & 0x80) {
    if (slice[0] !== 0x80) throw new Error('tar: 不支持负数的 base-256 size 字段');
    let value = 0;
    for (let i = 1; i < slice.length; i++) value = value * 256 + slice[i];
    return value;
  }
  const text = slice.toString('ascii').replace(/\0.*$/, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar: 八进制字段非法: "${text}"`);
  return parseInt(text, 8);
}

/** tar 头校验和：除 chksum 字段（148..155）按空格参与外，其余字节按无符号求和 */
function headerChecksum(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

export function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/**
 * 组装一个 ustar 头（512 字节）。name 超过 100 字节时按 '/' 切成 prefix/name。
 * @param {{name:string,size?:number,mode?:number,mtime?:number,type?:string,uid?:number,gid?:number,linkname?:string}} entry
 */
export function buildUstarHeader(entry) {
  const {
    name, size = 0, mode = 0o644,
    mtime = Math.floor(Date.now() / 1000),
    type = TYPE_FILE, uid = 0, gid = 0, linkname = '',
  } = entry;

  const header = Buffer.alloc(BLOCK_SIZE);
  let prefix = '';
  let nameField = String(name);

  if (Buffer.byteLength(nameField, 'utf8') > NAME_FIELD) {
    const raw = Buffer.from(nameField, 'utf8');
    let splitAt = -1;
    for (let i = raw.length - 1; i >= 0; i--) {
      if (raw[i] !== 0x2f /* '/' */) continue;
      if (raw.length - i - 1 <= NAME_FIELD && i <= PREFIX_FIELD) { splitAt = i; break; }
    }
    if (splitAt < 0) throw new Error(`tar: 路径过长，ustar 装不下: ${name}`);
    prefix = raw.subarray(0, splitAt).toString('utf8');
    nameField = raw.subarray(splitAt + 1).toString('utf8');
  }

  writeString(header, 0, NAME_FIELD, nameField);
  writeOctal(header, 100, 8, mode & 0o7777);
  writeOctal(header, 108, 8, uid);
  writeOctal(header, 116, 8, gid);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156); // chksum 先填空格再算
  header[156] = String(type || TYPE_FILE).charCodeAt(0);
  writeString(header, 157, 100, linkname);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 297, 32, 'linshe');   // gname

  const checksum = headerChecksum(header).toString(8).padStart(6, '0');
  header.write(checksum, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/**
 * 解析一个 ustar 头。
 * @returns {null|{path:string,rawName:string,size:number,mode:number,mtime:number,type:string,linkname:string}}
 *          全零块返回 null（归档结束标记）
 */
export function parseUstarHeader(block) {
  if (block.length < BLOCK_SIZE) throw new Error('tar: 头部不足 512 字节');
  if (isZeroBlock(block)) return null;

  const stored = readOctal(block, 148, 8);
  if (stored !== headerChecksum(block)) {
    throw new Error(`tar: 头部校验和不符（期望 ${headerChecksum(block)}，实际 ${stored}）`);
  }

  const nameField = readField(block, 0, NAME_FIELD);
  const prefix = readField(block, 345, PREFIX_FIELD);
  const rawName = prefix ? `${prefix}/${nameField}` : nameField;
  const isDir = block[156] === 0x35 /* '5' */;

  return {
    rawName,
    // 目录条目的名字按惯例带尾斜杠，这里统一去掉，调用方拿到的是干净相对路径
    path: !isDir && rawName.endsWith('/') ? rawName.slice(0, -1) : isDir ? rawName.replace(/\/+$/, '') : rawName,
    size: readOctal(block, 124, 12),
    mode: readOctal(block, 100, 8),
    mtime: readOctal(block, 136, 12),
    type: String.fromCharCode(block[156] || 0x30),
    linkname: readField(block, 157, 100),
  };
}

// ── 写：entries → tar 字节流 ─────────────────────────────────────────

/**
 * 把 entries 转成 tar 字节流（async generator，交给 pipeline 做背压）。
 * entry 形态：
 *   { path, type: '0'|'5', size?, mode?, mtime?, source?: 绝对路径, data?: Buffer }
 * 普通文件必须给 source 或 data，且 size 与实际字节数一致（不一致直接抛错，不产出坏归档）。
 */
export async function* tarEntryStream(entries) {
  for (const entry of entries) {
    const type = entry.type || TYPE_FILE;
    const isDir = type === TYPE_DIR;
    const name = isDir && !String(entry.path).endsWith('/') ? `${entry.path}/` : entry.path;

    let payload = entry.data || null;
    let source = entry.source || null;
    let size = entry.size;
    if (size === undefined) {
      if (payload) size = payload.length;
      else if (source) size = fs.statSync(source).size;
      else size = 0;
    }
    if (isDir) {
      if (size !== 0) throw new Error(`tar: 目录条目带数据: ${name}`);
      yield buildUstarHeader({ ...entry, name, size: 0, type: TYPE_DIR, mode: entry.mode ?? 0o755 });
      continue;
    }
    if (payload && payload.length !== size) throw new Error(`tar: data 长度与 size 不符: ${name}`);
    if (source && fs.statSync(source).size !== size) throw new Error(`tar: 文件已被改动，大小不符: ${name}`);

    yield buildUstarHeader({ ...entry, name, size, type });

    let written = 0;
    if (payload) {
      yield payload;
      written = payload.length;
    } else if (source) {
      for await (const chunk of fs.createReadStream(source, { highWaterMark: 1 << 20 })) {
        written += chunk.length;
        yield chunk;
      }
    }
    if (written !== size) throw new Error(`tar: 实际写入 ${written} 字节，与声明的 ${size} 不符: ${name}`);

    const padding = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding > 0) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(BLOCK_SIZE * 2); // 归档结束：两个全零块
}

/**
 * 把 entries 写成 .tar.gz 文件（流式，不全量进内存）。
 * @returns {Promise<{bytes:number}>}
 */
export async function writeTarGz(outFile, entries) {
  await pipeline(
    Readable.from(tarEntryStream(entries), { objectMode: false }),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(outFile),
  );
  return { bytes: fs.statSync(outFile).size };
}

/** 同 writeTarGz，但结果进内存（只给测试/小归档用）。 */
export async function createTarGzBuffer(entries) {
  const chunks = [];
  const sink = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  await pipeline(
    Readable.from(tarEntryStream(entries), { objectMode: false }),
    zlib.createGzip({ level: 6 }),
    sink,
  );
  return Buffer.concat(chunks);
}

// ── 读：tar 字节流 → 条目回调 ────────────────────────────────────────

/**
 * 增量 tar 解析器（Transform，objectMode=false）。
 *
 * 回调可以是 async：`_transform` 会 await 完再放行，因此磁盘写入天然获得背压，
 * 大归档不会在内存里堆起来。回调抛错 → 直接让 pipeline 失败。
 *
 *   onEntry(entry)          头部解析完成（目录/文件都会先来一次）
 *   onData(entry, chunk)    文件数据分片
 *   onEnd(entry)            该条目结束（目录与空文件也会立刻收到）
 */
export class TarParser extends Transform {
  constructor({ onEntry, onData, onEnd } = {}) {
    super();
    this._onEntry = onEntry || (() => {});
    this._onData = onData || (() => {});
    this._onEnd = onEnd || (() => {});
    this._buf = EMPTY;
    this._state = 'header';
    this._entry = null;
    this._remaining = 0;
    this._padding = 0;
  }

  _transform(chunk, _enc, cb) {
    this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
    this._drain().then(() => cb(), cb);
  }

  _flush(cb) {
    if (this._state === 'data' || this._state === 'pad') {
      return cb(new Error(`tar: 归档在文件数据中途截断（剩余 ${this._remaining} 字节）`));
    }
    if (this._buf.length > 0 && !isZeroBlock(this._buf)) {
      return cb(new Error('tar: 归档末尾有残缺数据（不足一个 512 字节块）'));
    }
    cb();
  }

  async _drain() {
    for (;;) {
      if (this._state === 'done') { this._buf = EMPTY; return; }

      if (this._state === 'header') {
        if (this._buf.length < BLOCK_SIZE) return;
        const headerBuf = this._buf.subarray(0, BLOCK_SIZE);
        this._buf = this._buf.subarray(BLOCK_SIZE);
        const header = parseUstarHeader(headerBuf);
        if (!header) { this._state = 'done'; this._buf = EMPTY; return; }

        this._entry = header;
        await this._onEntry(header);
        if (header.type === TYPE_DIR || header.size === 0) {
          await this._onEnd(this._entry);
          this._entry = null;
          continue;
        }
        this._remaining = header.size;
        this._state = 'data';
        continue;
      }

      if (this._state === 'data') {
        if (this._buf.length === 0) return;
        const take = Math.min(this._buf.length, this._remaining);
        const chunk = this._buf.subarray(0, take);
        this._buf = this._buf.subarray(take);
        await this._onData(this._entry, chunk);
        this._remaining -= take;
        if (this._remaining === 0) {
          this._padding = (BLOCK_SIZE - (this._entry.size % BLOCK_SIZE)) % BLOCK_SIZE;
          this._state = 'pad';
        }
        continue;
      }

      // state === 'pad'
      if (this._padding === 0) {
        const finished = this._entry;
        this._entry = null;
        this._state = 'header';
        await this._onEnd(finished);
        continue;
      }
      if (this._buf.length === 0) return;
      const take = Math.min(this._buf.length, this._padding);
      this._buf = this._buf.subarray(take);
      this._padding -= take;
    }
  }
}

/** 判断一段字节是否是 gzip 流（魔数 1f 8b） */
export function isGzip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/**
 * 从 gzip 压缩的内存字节流式解析 tar（增量喂给 TarParser，不会把解压结果整体展开）。
 * @param {Buffer} gzipBuffer
 * @param {{onEntry?:Function,onData?:Function,onEnd?:Function}} handlers
 */
export async function readTarGzStream(gzipBuffer, handlers) {
  const parser = new TarParser(handlers);
  await pipeline(
    Readable.from([gzipBuffer], { objectMode: false }),
    zlib.createGunzip(),
    parser,
  );
}

/**
 * 把 .tar.gz 完整读成条目数组（只给测试 / 小归档用，大归档请用 readTarGzStream）。
 * @returns {Promise<Array<{path:string,type:string,size:number,mode:number,mtime:number,linkname:string,data:Buffer|null}>>}
 */
export async function readTarGzEntries(gzipBuffer) {
  const results = [];
  let current = null;
  await readTarGzStream(gzipBuffer, {
    onEntry(entry) {
      current = { ...entry, data: entry.type === TYPE_DIR ? null : Buffer.alloc(0) };
      results.push(current);
    },
    onData(_entry, chunk) {
      current.data = Buffer.concat([current.data, chunk]);
    },
  });
  return results;
}
