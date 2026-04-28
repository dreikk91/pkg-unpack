#!/usr/bin/env node
/**
 * pkg-unpack.js — розпаковує Node.js exe, запаковані через Vercel/pkg
 *
 * Використання:
 *   node pkg-unpack.js <exe-file> [output-dir]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Весь скрипт виконується в async IIFE щоб дозволити await для декомпресії
(async () => {

// ── CLI ──────────────────────────────────────────────────────────────────────

const [,, exeArg, outArg] = process.argv;
if (!exeArg) {
  console.error('Використання: node pkg-unpack.js <exe-file> [output-dir]');
  process.exit(1);
}

const EXE_PATH = path.resolve(exeArg);
const OUT_DIR  = path.resolve(outArg || path.basename(exeArg, '.exe') + '_unpacked');

if (!fs.existsSync(EXE_PATH)) {
  console.error('Файл не знайдено:', EXE_PATH);
  process.exit(1);
}

console.log('Файл :', EXE_PATH);
console.log('Вивід:', OUT_DIR);
console.log();

// ── 1. Читаємо бінарник ──────────────────────────────────────────────────────

const exeBuf  = fs.readFileSync(EXE_PATH);
const exeText = exeBuf.toString('latin1');

if (!exeText.includes('pkg/prelude')) {
  console.error('Це не pkg-бінарник (маркер pkg/prelude не знайдено).');
  process.exit(1);
}
console.log('✓ pkg маркер знайдено');

// ── 2. PAYLOAD / PRELUDE координати ─────────────────────────────────────────

function extractConst(text, name) {
  const m = text.match(new RegExp(`var ${name}\\s*=\\s*'(\\d+)\\s*'\\s*\\|\\s*0`));
  if (!m) throw new Error(`Не вдалося знайти константу ${name}`);
  return parseInt(m[1], 10);
}

let PAYLOAD_POSITION, PAYLOAD_SIZE, PRELUDE_POSITION, PRELUDE_SIZE;
try {
  PAYLOAD_POSITION = extractConst(exeText, 'PAYLOAD_POSITION');
  PAYLOAD_SIZE     = extractConst(exeText, 'PAYLOAD_SIZE');
  PRELUDE_POSITION = extractConst(exeText, 'PRELUDE_POSITION');
  PRELUDE_SIZE     = extractConst(exeText, 'PRELUDE_SIZE');
} catch (e) {
  console.error('Помилка розбору констант:', e.message);
  process.exit(1);
}

console.log(`✓ PAYLOAD  offset=${PAYLOAD_POSITION}  size=${PAYLOAD_SIZE}`);
console.log(`✓ PRELUDE  offset=${PRELUDE_POSITION}  size=${PRELUDE_SIZE}`);
console.log();

// ── 3. Prelude ───────────────────────────────────────────────────────────────

const payloadBuf = exeBuf.slice(PAYLOAD_POSITION, PAYLOAD_POSITION + PAYLOAD_SIZE);
const preludeBuf = exeBuf.slice(PRELUDE_POSITION, PRELUDE_POSITION + PRELUDE_SIZE);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, '_prelude.js'), preludeBuf);
console.log('✓ _prelude.js збережено');

// ── Допоміжні функції ────────────────────────────────────────────────────────

// UTF-16 LE → UTF-8: рахуємо пари [printable + 0x00]
function normalizeEncoding(buf) {
  const sampleLen = Math.min(buf.length, 1024);
  let utf16Pairs = 0;
  for (let i = 0; i < sampleLen - 1; i += 2) {
    const a = buf[i], b = buf[i + 1];
    if (((a >= 0x09 && a <= 0x0D) || (a >= 0x20 && a <= 0x7E)) && b === 0x00)
      utf16Pairs++;
  }
  if (Math.floor(sampleLen / 2) > 0 && utf16Pairs / Math.floor(sampleLen / 2) > 0.35)
    return buf.toString('utf16le');
  return buf.toString('utf8');
}

// Обрізати бінарний заголовок — знайти перший фрагмент що виглядає як JS.
// V8-бінарні заголовки завершуються нульовими байтами (\x00), тому шукаємо
// JS-патерн після ^, \n АБО \x00.
const JS_LINE_RE = /(?:^|[\n\x00])((?:"use strict"|'use strict'|var |const |let |function |class |exports\.|module\.|Object\.|\/\/[^\n]|\/\*)[^\x00]{2})/m;
function trimBinaryHeader(code) {
  const m = JS_LINE_RE.exec(code);
  if (m && m.index > 0)
    code = code.slice(m.index + (/[\n\x00]/.test(code[m.index]) ? 1 : 0));
  return code.trim();
}

// Нормалізація modulePath з webpack: прибирає префікс exe-назви та ../ сегменти
// "surgard/../../../node_modules/foo" → "node_modules/foo"
// "surgard/./dist/backend/index.js"  → "dist/backend/index.js"
function normalizeModulePath(p) {
  // Прибрати префікс "name/./" або "name/../"
  p = p.replace(/^[^/]+\/\.\//, '').replace(/^[^/]+\/.\.\//, '');
  // Якщо залишились ../ — прив'язати до відомих якорів
  if (p.startsWith('../') || p.startsWith('../../')) {
    const nmIdx = p.lastIndexOf('/node_modules/');
    if (nmIdx !== -1) return 'node_modules/' + p.slice(nmIdx + '/node_modules/'.length);
    const distIdx = p.lastIndexOf('/dist/');
    if (distIdx !== -1) return 'dist/' + p.slice(distIdx + '/dist/'.length);
    // Прибрати всі провідні ../
    p = p.replace(/^(\.\.\/)+/, '');
  }
  return p;
}

// Безпечний шлях файлової системи — без небезпечних символів і без виходу вгору
function safePath(p) {
  return p.split('/').filter(s => s !== '..').map(s => s.replace(/[:"*?^|<>]/g, '_')).join(path.sep);
}

// Перевіряє що outPath знаходиться всередині baseDir
function isInsideDir(baseDir, outPath) {
  const rel = path.relative(baseDir, outPath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function writeFile(outPath, content, binary = false) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (binary)
    fs.writeFileSync(outPath, content);
  else
    fs.writeFileSync(outPath, content, 'utf8');
}

// ── 4. Webpack модулі з //# sourceURL ────────────────────────────────────────

const payloadText = payloadBuf.toString('utf8');

const SOURCE_URL_RE = /\/\/#\s*sourceURL=webpack:\/\/([^?]+)\?/g;
const entries = [];
let m;
while ((m = SOURCE_URL_RE.exec(payloadText)) !== null) {
  entries.push({ modulePath: m[1], markerStart: m.index, markerEnd: m.index + m[0].length });
}

if (entries.length === 0) {
  console.error('webpack модулі не знайдено в payload.');
  process.exit(1);
}

// Другий прохід: деякі секції bundle закодовані UTF-16 LE.
// Шукаємо //# sourceURL= у вигляді UTF-16 LE байтів у payloadBuf.
const SRC_MARKER_U16 = Buffer.from('//# sourceURL=webpack://', 'utf16le');
let u16Pos = 0;
while ((u16Pos = payloadBuf.indexOf(SRC_MARKER_U16, u16Pos)) !== -1) {
  // Читаємо шлях — до символу '?' або кінця рядка (UTF-16)
  let pathEnd = u16Pos + SRC_MARKER_U16.length;
  while (pathEnd + 1 < payloadBuf.length) {
    const ch = payloadBuf.readUInt16LE(pathEnd);
    if (ch === 0x003F || ch === 0x000A || ch === 0x0000) break; // '?' або '\n'
    pathEnd += 2;
  }
  const fullPath = payloadBuf.slice(u16Pos + SRC_MARKER_U16.length, pathEnd).toString('utf16le');
  const markerEnd = pathEnd + 2; // пропустити '?'

  entries.push({
    modulePath : fullPath,
    markerStart: u16Pos,
    markerEnd,
    utf16      : true,  // позначка що секція у UTF-16 LE
    u16Pos,
  });
  u16Pos++;
}

console.log(`✓ Знайдено ${entries.length} webpack sourceURL модулів (включно з UTF-16 LE секціями)`);

// Множина вже витягнутих шляхів (для дедублікації)
const extracted = new Set();

let saved = 0, skipped = 0;

// Сортуємо entries за markerStart щоб UTF-16 секції стояли в правильному порядку
entries.sort((a, b) => a.markerStart - b.markerStart);

for (let i = 0; i < entries.length; i++) {
  const curr      = entries[i];
  const codeEnd   = curr.markerStart;
  const codeStart = i === 0 ? 0 : entries[i - 1].markerEnd;

  let slice = payloadBuf.slice(codeStart, codeEnd);
  let code;
  if (curr.utf16) {
    // Між двома UTF-16 LE модулями може бути бінарний V8 blob.
    // Знаходимо першу UTF-16 LE JS-послідовність у сирих байтах зрізу,
    // щоб пропустити бінарний заголовок до декодування.
    const JS_U16_PATTERNS = [
      Buffer.from('"use strict"', 'utf16le'),
      Buffer.from('Object.defineProperty', 'utf16le'),
      Buffer.from('var __importDefault', 'utf16le'),
      Buffer.from('exports.', 'utf16le'),
      Buffer.from('module.exports', 'utf16le'),
      Buffer.from('var ', 'utf16le'),
    ];
    let jsStart = -1;
    for (const pat of JS_U16_PATTERNS) {
      const idx = slice.indexOf(pat);
      if (idx !== -1 && (jsStart === -1 || idx < jsStart)) jsStart = idx;
    }
    if (jsStart > 0) slice = slice.slice(jsStart);
    code = trimBinaryHeader(slice.toString('utf16le'));
  } else {
    code = trimBinaryHeader(normalizeEncoding(slice));
  }
  if (!code) { skipped++; continue; }

  let cleanPath = normalizeModulePath(curr.modulePath);

  if (/[*?^|<>]/.test(cleanPath)) { skipped++; continue; }

  const outPath = path.join(OUT_DIR, safePath(cleanPath));
  if (!isInsideDir(OUT_DIR, outPath)) { skipped++; continue; }
  writeFile(outPath, code);
  extracted.add(cleanPath.replace(/^\.\//, ''));
  saved++;
}
console.log(`✓ Збережено: ${saved}  (пропущено: ${skipped})`);

// ── 5. Webpack inline модулі (без //# sourceURL) ─────────────────────────────
//
// Деякі модулі в webpack bundle не мають //# sourceURL маркера.
// Вони зберігаються у реєстрі __webpack_modules__ як:
//   /***/ "./path/to/file.js":
//   /***/ ((module, exports, __webpack_require__) => { ... })
// або компактніше:
//   "./path/to/file.js": ((__unused_webpack_module, exports) => { ... })

console.log('\n── Webpack inline модулі ────────────────────────────────────────');

// Знаходимо всі записи реєстру модулів у тексті bundle
// Формат: /***/ "path": або просто "path":\n/***/ (
const MODULE_ENTRY_RE = /(?:\/\*{3}\/\s+)?["'](\.\/[^"'\n\r]{2,200}\.(?:js|json|ts))["']\s*:\s*\n?(?:\/\*{3}\/\s*)?\((?!.*?__webpack_require__\()/gm;

const moduleEntries = [];
let me;
while ((me = MODULE_ENTRY_RE.exec(payloadText)) !== null) {
  // Відкидаємо якщо це виклик require (перед ним є require або webpack_require)
  const before = payloadText.slice(Math.max(0, me.index - 30), me.index);
  if (/require\s*$|webpack_require\s*$/.test(before)) continue;
  moduleEntries.push({ filePath: me[1], index: me.index, end: me.index + me[0].length });
}

let inlineSaved = 0;
for (let i = 0; i < moduleEntries.length; i++) {
  const entry    = moduleEntries[i];
  const normPath = entry.filePath.replace(/^\.\//, '');

  if (extracted.has(normPath)) continue; // вже витягнуто через sourceURL

  // Код від кінця запису до наступного запису або sourceURL
  const nextIndex = i + 1 < moduleEntries.length ? moduleEntries[i + 1].index : payloadText.length;
  let code = payloadText.slice(entry.end, nextIndex);

  // Прибрати webpack closure в кінці: /***/ }),  або /***/ })
  code = code.replace(/\s*\/\*{3}\/\s*\}[)\s,]*$/, '').trim();
  // Прибрати крайній /***/ }); якщо є
  code = code.replace(/\s*\}\);\s*$/, '').trim();

  if (!code || code.length < 15) continue;

  const cleanPath = normPath.split('/').join(path.sep);
  const outPath   = path.join(OUT_DIR, safePath(normPath));
  writeFile(outPath, code);
  extracted.add(normPath);
  inlineSaved++;
  console.log('  +', entry.filePath);
}
console.log(`✓ Inline модулів збережено: ${inlineSaved}`);

// ── 6. VFS manifest — точне витягування за JSON-індексом ─────────────────────
//
// pkg зберігає у бінарнику VFS manifest у вигляді тексту:
//   {<vfs json>}\n,\n"<entryPoint>"\n,\n{<symlinks>}\n,\n{<filesDict>}\n,\n<0|1|2>
// де кожен запис VFS: "path": {"0": [startPos, size]} — точна позиція у payload.
// Формат регулярного виразу взято з проекту pkg-unpacker.

console.log('\n── VFS manifest (JSON-індекс) ───────────────────────────────────');

const RAW_PROPS_RE = /\{.*\}\n,\n".*"\n,\n\{.*\}(?:\n,\n\{.*\}\n,\n([012]))?/g;
const zlib = require('zlib');
const { promisify } = require('util');
const gunzipAsync    = promisify(zlib.gunzip);
const brotliAsync    = promisify(zlib.brotliDecompress);

// Читаємо бінарник як utf-8 рядок для пошуку VFS JSON
const exeUtf8 = exeBuf.toString('utf8');
let vfsManifestSaved = 0, vfsManifestNative = 0;
const manifestVisited = new Set();

const rawMatches = [...exeUtf8.matchAll(RAW_PROPS_RE)];
console.log(`  Знайдено VFS manifest блоків: ${rawMatches.length}`);

for (const rawMatch of rawMatches) {
  let vfs = {}, entryPoint = '', symlinks = {}, filesDict = {}, doCompress = 0;
  try {
    const parts = rawMatch[0].split('\n,\n');
    vfs         = JSON.parse(parts[0]);
    entryPoint  = (parts[1] || '""').replace(/^"|"$/g, '');
    symlinks    = JSON.parse(parts[2] || '{}');
    filesDict   = JSON.parse(parts[3] || '{}');
    doCompress  = parseInt(parts[4] || '0') || 0;
  } catch { continue; }

  const entries2 = Object.entries(vfs);
  if (!entries2.length) continue;
  console.log(`  VFS записів: ${entries2.length}  compress=${doCompress}  entry="${entryPoint}"`);

  // Побудувати множину шляхів що є директоріями (мають нащадків у VFS).
  // Нормалізуємо так само як vfsNorm: strip drive letter, forward slashes.
  const dirPaths = new Set();
  for (const [p] of entries2) {
    const norm = p.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '');
    const parts = norm.split('/');
    for (let d = 1; d < parts.length; d++) {
      dirPaths.add(parts.slice(0, d).join('/'));
    }
  }

  // Відновлення стислих шляхів (filesDict — словник скорочень)
  const dictRev = {};
  Object.entries(filesDict).forEach(([k, v]) => { dictRev[v] = k; });
  const sep = Object.keys(vfs)[0]?.includes('$') ? '$' : '/';

  function toOriginal(shortPath) {
    if (!Object.keys(dictRev).length) return shortPath;
    return shortPath.split(sep).map(x => dictRev[x] || x).join('\\');
  }

  for (let [vfsPath, entry] of entries2) {
    // Відновити повний шлях якщо стислий
    if (Object.keys(dictRev).length) vfsPath = toOriginal(vfsPath);

    // Нормалізувати шлях до відносного
    let relPath = vfsPath
      .replace(/\\/g, '/')
      .replace(/^[A-Za-z]:\//, '')          // прибрати диск
      .replace(/^.*?\/(node_modules\/)/, 'node_modules/')
      .replace(/^.*?\/(dist\/)/, 'dist/')
      .replace(/^.*?\/(src\/)/, 'src/');

    if (manifestVisited.has(relPath)) continue;
    manifestVisited.add(relPath);
    if (/[*?^|<>]/.test(relPath)) continue;

    // Вибрати тип запису:
    //   "1" = вихідний текст (JS/JSON) — основний для читабельного коду
    //   "0" = V8 bytecode blob  — тільки для .node нативних модулів
    //   "2" = директорія (список файлів) — пропускаємо
    //   "3" = метадані файлу  — пропускаємо
    const isNative = relPath.endsWith('.node');
    const storeEntry = isNative ? (entry['0'] || entry['1']) : entry['1'];
    if (!storeEntry || !Array.isArray(storeEntry)) continue;

    const [startPos, size] = storeEntry;
    if (typeof startPos !== 'number' || typeof size !== 'number' || size <= 0) continue;

    const outBase  = isNative ? '_native' : 'vfs';
    const outPath  = path.join(OUT_DIR, outBase, safePath(relPath));
    if (!isInsideDir(OUT_DIR, outPath)) continue;

    // Читаємо bytes безпосередньо з payload
    const raw = payloadBuf.slice(startPos, startPos + size);

    // Розпаковуємо якщо потрібно
    let content = raw;
    if (doCompress === 1) {
      try { content = await gunzipAsync(raw); } catch { content = raw; }
    } else if (doCompress === 2) {
      try { content = await brotliAsync(raw); } catch { content = raw; }
    }

    // Пропустити якщо цей шлях є директорією (має нащадків у VFS)
    const vfsNorm = vfsPath.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '');
    if (dirPaths.has(vfsNorm)) continue;

    const normPath = relPath.replace(/^\.\//, '');

    if (isNative) {
      try {
        writeFile(outPath, content, true);
      } catch (e) {
        if (e.code !== 'EISDIR' && e.code !== 'EEXIST') throw e;
        continue;
      }
      extracted.add(normPath);
      vfsManifestNative++;
      console.log(`  [.node] ${relPath}  (${size} байт)`);
    } else {
      // Тип "1" — вихідний текст, завжди UTF-8; нормалізуємо на випадок рідкісних UTF-16 LE артефактів
      const raw8 = content.toString('utf8');
      const textContent = raw8.includes('\x00') ? trimBinaryHeader(normalizeEncoding(content)) : raw8;
      if (!textContent) continue;
      try {
        writeFile(outPath, textContent);
      } catch (e) {
        if (e.code !== 'EISDIR' && e.code !== 'EEXIST') throw e;
        continue;
      }
      extracted.add(normPath);
      vfsManifestSaved++;
    }
  }
}

console.log(`✓ VFS manifest файлів: ${vfsManifestSaved}`);
console.log(`✓ VFS manifest native: ${vfsManifestNative}`);

// ── 7. VFS файли через metadata-якорі (fallback для старіших pkg) ─────────────
//
// pkg дописує до кожного файлу VFS JSON-метадані:
//   {"mode":33206,"size":346,"isFileValue":true,...}
// де "size" — точний розмір вмісту файлу в байтах.

console.log('\n── VFS metadata-якорі (fallback) ────────────────────────────────');

const META_RE = /\{"mode":\d+,"size":(\d+),"isFileValue":true[^}]*\}/g;
const PATH_RE = /(?:[a-zA-Z]:[\\\/]|\.\/|\.\.\/)[^\x00\n"'<>|*?]{4,}\.(?:js|json|ts|node)/g;

let vfaSaved = 0, vfaNative = 0;
const vfaVisited = new Set();

let metaMatch;
while ((metaMatch = META_RE.exec(payloadText)) !== null) {
  const fileSize  = parseInt(metaMatch[1]);
  const metaStart = metaMatch.index;   // файл закінчується тут
  const fileStart = metaStart - fileSize;

  if (fileSize <= 0 || fileSize > 20_000_000 || fileStart < 0) continue;

  // Шлях файлу — шукаємо у 12KB перед вмістом у сирому бінарнику exe
  // Підтримуємо і ASCII і UTF-16 LE (де між байтами є \x00)
  const searchFrom  = Math.max(0, PAYLOAD_POSITION + fileStart - 12288);
  const searchTo    = PAYLOAD_POSITION + fileStart;
  const searchBuf   = exeBuf.slice(searchFrom, searchTo);
  // Спробувати latin1 (ASCII)
  const searchText  = searchBuf.toString('latin1');
  // Спробувати UTF-16 LE (прибрати нульові байти між символами)
  const searchU16   = searchBuf.filter((b, i) => i % 2 === 0).toString('latin1');

  const pathMatches = [...searchText.matchAll(PATH_RE), ...searchU16.matchAll(PATH_RE)];
  if (!pathMatches.length) continue;

  const rawPath = pathMatches[pathMatches.length - 1][0];
  const isNode  = rawPath.endsWith('.node');

  // Нормалізація шляху
  let relPath = rawPath
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:\//, '')
    .replace(/^.*?\/(node_modules\/)/, 'node_modules/')
    .replace(/^.*?\/(dist\/)/, 'dist/')
    .replace(/^.*?\/(src\/)/, 'src/');

  if (vfaVisited.has(relPath)) continue;
  vfaVisited.add(relPath);

  if (/[*?^|<>]/.test(relPath)) continue;

  const outBase = isNode ? '_native' : '_vfs';
  const outPath = path.join(OUT_DIR, outBase, safePath(relPath));

  if (isNode) {
    // Витягуємо бінарний .node файл побайтово
    const content = payloadBuf.slice(fileStart, metaStart);
    writeFile(outPath, content, true);
    vfaNative++;
    console.log(`  [.node] ${relPath}  (${fileSize} байт)`);
  } else {
    // Текстовий файл: нормалізуємо кодування
    const content = trimBinaryHeader(normalizeEncoding(payloadBuf.slice(fileStart, metaStart)));
    if (!content) continue;

    const normPath = relPath.replace(/^\.\//, '');
    if (extracted.has(normPath)) continue; // вже є з webpack

    writeFile(outPath, content);
    extracted.add(normPath);
    vfaSaved++;
  }
}

console.log(`✓ VFS JS/JSON файлів: ${vfaSaved}`);
console.log(`✓ Native .node бінарників: ${vfaNative}`);

// ── 7. VFS fallback: JS блоки без metadata ───────────────────────────────────
//
// Файли що не мають metadata-якоря (старіші версії pkg або інший формат)
// знаходимо старим методом: читаємі JS блоки після webpack bundle.

console.log('\n── VFS fallback (без metadata) ──────────────────────────────────');

const lastEntry    = entries[entries.length - 1];
const afterWebpack = lastEntry ? lastEntry.markerEnd : 0;

const JS_START_RE = /(?:"use strict"|'use strict'|var |const |let |function |class |exports\.|module\.exports)/;
const FALLBACK_PATH_RE = /(?:[a-zA-Z]:[\\\/]|\.\/|\.\.\/)[^\x00\n"'<>|*?]{4,}\.(?:js|json)/g;

let pos = afterWebpack, fbSaved = 0;

while (pos < payloadBuf.length - 100) {
  const b = payloadBuf[pos];
  if (b >= 0x20 && b <= 0x7E) {
    let end = pos, badRun = 0;
    while (end < payloadBuf.length && badRun < 6) {
      const c = payloadBuf[end];
      if (c < 0x09 || (c > 0x0D && c < 0x20) || c > 0x7E) badRun++;
      else badRun = 0;
      end++;
    }
    const blockLen = end - pos - badRun;
    if (blockLen >= 150) {
      const code = payloadBuf.slice(pos, pos + blockLen).toString('utf8');
      if (JS_START_RE.test(code) && !code.includes('//# sourceURL')) {
        // Шукаємо шлях у бінарнику перед блоком
        const searchFrom  = Math.max(0, PAYLOAD_POSITION + pos - 4096);
        const searchText  = exeBuf.slice(searchFrom, PAYLOAD_POSITION + pos).toString('latin1');
        const pathMatches = [...searchText.matchAll(FALLBACK_PATH_RE)];

        if (pathMatches.length) {
          const rawPath = pathMatches[pathMatches.length - 1][0];
          let relPath = rawPath
            .replace(/\\/g, '/').replace(/^[a-zA-Z]:\//, '')
            .replace(/^.*?\/(node_modules\/)/, 'node_modules/')
            .replace(/^.*?\/(dist\/)/, 'dist/');

          const normPath = relPath.replace(/^\.\//, '');
          if (!vfaVisited.has(relPath) && !extracted.has(normPath) && !/[*?^|<>]/.test(relPath)) {
            vfaVisited.add(relPath);
            extracted.add(normPath);
            const outPath = path.join(OUT_DIR, '_vfs', safePath(relPath));
            writeFile(outPath, trimBinaryHeader(code) || code.trim());
            fbSaved++;
          }
        }
      }
      pos = end;
    } else { pos++; }
  } else { pos++; }
}

console.log(`✓ Fallback VFS файлів: ${fbSaved}`);

// ── 8. Підсумок ───────────────────────────────────────────────────────────────

console.log('\n════════════════════════════════════════');
const allPaths     = entries.map(e => e.modulePath);
const projectFiles = allPaths.filter(p => !p.includes('node_modules'));
const depsCount    = allPaths.filter(p =>  p.includes('node_modules')).length;

console.log(`Webpack файли проєкту (${projectFiles.length}):`);
projectFiles.forEach(f => console.log('  ', f.replace(/^[^/]+\/\.\//, '')));
console.log(`\nWebpack залежності:   ${depsCount} модулів`);
console.log(`Inline модулі:        ${inlineSaved}`);
console.log(`VFS manifest файли:   ${vfsManifestSaved}`);
console.log(`VFS metadata файли:   ${vfaSaved + fbSaved}`);
console.log(`Native .node файли:   ${vfsManifestNative + vfaNative}`);
console.log('\nГотово! Результат у:', OUT_DIR);

})().catch(e => { console.error(e); process.exit(1); });
