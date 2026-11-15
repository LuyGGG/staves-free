'use strict';
const $ = id => document.getElementById(id);
const MAX_FILE = 10 * 1024 * 1024, MAX_LIBRARY = 50 * 1024 * 1024, AUTO_PARTS = 16;
let files = [], current = null, converted = null, db = null, worker, workerFile = null;
let sequence = 0, viewVersion = 0, busyCount = 0, toastTimer, installPrompt;
const pending = new Map();

/* Engine errors and warnings arrive as stable codes; the text shown here is Chinese. */
const messages = {
  'no-parts': '请至少选择一个声部。',
  'not-midi': '请选择有效的标准 MIDI 文件（.mid 或 .midi）。',
  'bad-header': '这个 MIDI 文件的文件头无效。',
  'no-notes': '这个 MIDI 文件中没有可转换的音符。',
  'invalid-event': '这个 MIDI 文件包含无效数据，无法转换。',
  'format-2': '暂不支持 MIDI 格式 2，请先另存为格式 0 或 1。',
  'smpte': '暂不支持 SMPTE 时间格式，请以音乐节拍格式重新导出 MIDI。',
  'track-count': 'MIDI 轨道数量无效或过多。',
  'too-many-events': '这个 MIDI 文件的事件过多，无法安全显示。',
  'too-many-staves': '选中的声部需要超过 32 个谱表，请减少声部后重试。',
  'too-many-measures': '这份乐谱超过 1,000 小节，请先拆分 MIDI 文件。',
  'too-many-notes': '文件超过 30,000 个音符，请先拆成较小的文件。',
  'meter-too-fine': '当前拍号需要更精细的节奏精度，请选择十六分或三十二分音符。',
  'bad-grid': '节奏精度无效。',
  'bad-key': '调号无效。',
  'truncated': '文件不完整，已转换可读取的部分。',
  'corrupt-track': '有轨道包含无效数据，该轨道在出错处之后的内容未转换。',
  'unclosed-notes': '部分音符没有结束事件，已在轨道结束时截断。',
  'pitch-bend': '弯音效果不会反映在五线谱音高中。',
  'sustain-pedal': '暂不计算延音踏板延长的时值，音符长度按 MIDI 按下与释放事件转换。',
  'percussion-mapped': '打击乐按通用 MIDI 鼓组映射到简化的五线鼓谱。',
  'tempo-varies': '速度持续变化（自由速度演奏），乐谱只标注开头的速度。',
  'free-timing': '很多音符没有落在节拍网格上（像是实时演奏录制的），谱面上的节奏只是近似。'
};
const explain = e => messages[e?.code] || e?.message || String(e);
const keyLabel = key => {
  const name = Staves.keyName(key).replace('#', '♯').replace(/^([A-G])b/, '$1♭');
  return (key.minor ? name.slice(0, -1) + ' 小调' : name + ' 大调') + (key.source === 'estimated' ? '（推断）' : '');
};
const sourceLabel = {default: '默认音色', name: '按轨道名推断'};
const gridLabel = {8: '八分音符', 16: '十六分音符', 32: '三十二分音符'};

function toast(text, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  toastTimer = setTimeout(() => $('toast').hidden = true, error ? 10000 : 5000);
}
function busy(on, message = '正在写下你的旋律…') {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  $('busy-message').textContent = message; $('busy').hidden = !busyCount;
  document.querySelector('.app-shell').inert = busyCount > 0;
}

/* ---------- Background conversion ---------- */

function createWorker() {
  worker = new Worker('worker.js'); workerFile = null;
  worker.onmessage = ({data}) => {
    const task = pending.get(data.id); if (!task) return;
    clearTimeout(task.timer); pending.delete(data.id);
    if (data.error) task.reject(Object.assign(Error(data.error.message), {code: data.error.code}));
    else task.resolve(data.result);
  };
  worker.onerror = () => resetWorker('后台转换发生错误，请重新打开乐谱。');
}
function resetWorker(message) {
  worker?.terminate();
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error(message)); }
  pending.clear();
  try { createWorker(); } catch { worker = null; }
}
/* `file` is {id, bytes}. The bytes are only sent when the worker does not already hold that file. */
async function runWorker(action, file, options = {}, title = '') {
  try { return await postToWorker(action, file, options, title); }
  catch (e) { if (e.code !== 'not-loaded') throw e; workerFile = null; return postToWorker(action, file, options, title); }
}
function postToWorker(action, file, options, title) {
  if (!worker) return Promise.reject(Error('浏览器无法启动后台转换。请使用较新的 Safari、Chrome、Edge 或 Firefox。'));
  return new Promise((resolve, reject) => {
    const id = ++sequence, send = workerFile !== file.id, copy = send ? file.bytes.slice(0) : null;
    const timer = setTimeout(() => resetWorker('文件转换超时，请尝试较小的 MIDI 文件。'), 45000);
    pending.set(id, {resolve, reject, timer});
    if (send) workerFile = file.id;
    worker.postMessage({id, action, file: file.id, bytes: copy, options, title}, send ? [copy] : []);
  });
}

/* ---------- Local library (IndexedDB) ---------- */

function openDB() {
  return new Promise((resolve, reject) => {
    let done = false;
    const request = indexedDB.open('staves-library', 1);
    const timer = setTimeout(() => { done = true; reject(Error('本地存储暂不可用。')); }, 4000);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('files')) request.result.createObjectStore('files', {keyPath: 'id'}); };
    request.onsuccess = () => {
      if (done) { request.result.close(); return; }
      clearTimeout(timer); request.result.onversionchange = () => request.result.close(); resolve(request.result);
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onblocked = () => { clearTimeout(timer); reject(Error('本地存储被其他窗口占用。')); };
  });
}
function dbAction(mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode), request = action(tx.objectStore('files'));
    let result;
    request.onsuccess = () => result = request.result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || request.error);
    tx.onabort = () => reject(tx.error || Error('本地保存失败。'));
  });
}
function libraryView() {
  $('file-count').textContent = files.length; $('file-list').replaceChildren();
  if (!files.length) {
    const p = document.createElement('p'); p.className = 'library-empty'; p.textContent = '你的下一段旋律，从这里开始。';
    $('file-list').append(p); return;
  }
  for (const file of [...files].sort((a, b) => b.created - a.created)) {
    const active = current?.id === file.id;
    const row = document.createElement('div'); row.className = 'file-row' + (active ? ' active' : '');
    const button = document.createElement('button'); button.className = 'file-open'; button.title = file.name; button.setAttribute('aria-current', active ? 'true' : 'false');
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = '♫'; icon.setAttribute('aria-hidden', 'true');
    const info = document.createElement('span'), name = document.createElement('span'), size = document.createElement('span');
    name.className = 'file-name'; name.textContent = file.name;
    size.className = 'file-size'; size.textContent = `MIDI · ${Math.max(1, Math.round(file.bytes.byteLength / 1024))} KB`;
    info.append(name, size); button.append(icon, info); button.addEventListener('click', () => openFile(file));
    const remove = document.createElement('button'); remove.className = 'file-delete'; remove.textContent = '×'; remove.setAttribute('aria-label', `删除 ${file.name}`);
    remove.addEventListener('click', () => deleteFile(file));
    row.append(button, remove); $('file-list').append(row);
  }
}
async function deleteFile(file) {
  if (!confirm(`从此浏览器的乐谱库中删除《${file.name}》？设备上的原始文件不会被删除。`)) return;
  try {
    if (db) await dbAction('readwrite', s => s.delete(file.id));
    files = files.filter(f => f.id !== file.id);
    if (current?.id === file.id) {
      viewVersion++; current = null; converted = null;
      $('score').replaceChildren(); $('editor').hidden = true; $('welcome').hidden = false;
      document.title = 'Staves · 让 MIDI 跃然纸上';
    }
    libraryView(); toast('已从本地乐谱库删除。');
  } catch (e) { toast('删除失败：' + explain(e), true); }
}
async function importFiles(input) {
  const incoming = Array.from(input); if (!incoming.length) return;
  busy(true, '正在读取 MIDI 文件…');
  let first, imported = 0;
  const failures = [];
  try {
    for (const file of incoming) {
      try {
        if (!/\.(mid|midi|rmi)$/i.test(file.name)) throw Error('请选择 .mid 或 .midi 文件。');
        if (file.size > MAX_FILE) throw Error('单个文件不能超过 10 MB。');
        if (files.reduce((s, f) => s + f.bytes.byteLength, 0) + file.size > MAX_LIBRARY) throw Error('乐谱库最多存储 50 MB，请删除一些文件后重试。');
        const record = {id: crypto.randomUUID(), name: file.name.replace(/\.(mid|midi|rmi)$/i, ''), bytes: await file.arrayBuffer(), created: Date.now()};
        await runWorker('inspect', record); // rejects files that are not readable MIDI
        if (db) { try { await dbAction('readwrite', s => s.put(record)); } catch { throw Error('浏览器存储空间不足或不允许保存，请检查存储设置。'); } }
        files.push(record); first = first || record; imported++;
      } catch (e) { failures.push(`${file.name}：${explain(e)}`); }
    }
    libraryView();
  } finally { busy(false); $('file-input').value = ''; }
  if (first) await openFile(first);
  if (failures.length) toast(`${imported ? `已导入 ${imported} 个文件。\n` : ''}${failures.join('\n')}`, true);
  else if (imported > 1) toast(`已导入 ${imported} 个文件，可在乐谱库中切换。`);
}

/* ---------- Score view ---------- */

function partLabel(part) {
  const label = document.createElement('label'), input = document.createElement('input'), name = document.createElement('span'), detail = document.createElement('span');
  input.type = 'checkbox'; input.value = part.id; input.checked = true; input.addEventListener('change', () => convert());
  name.className = 'part-name'; name.textContent = part.name;
  const instrument = Staves.instrumentName(part.program, 'zh');
  detail.className = 'part-instrument';
  detail.textContent = [part.name.includes(instrument) ? '' : instrument, sourceLabel[part.source] || '', `${part.notes} 个音符`].filter(Boolean).join(' · ');
  label.title = `${part.name} — ${instrument}（${Staves.instrumentFamily(part.program, 'zh')}）`;
  label.append(input, name, detail);
  return label;
}
async function openFile(file) {
  const version = ++viewVersion;
  current = file; converted = null; setExport(false); libraryView();
  $('welcome').hidden = true; $('editor').hidden = false;
  $('score-title').textContent = file.name; $('score-meta').textContent = '正在识别声部与乐器…';
  $('score').replaceChildren(); $('score-warnings').hidden = true; $('part-list').replaceChildren(); $('key-select').value = 'auto';
  $('rhythm-grid').value = 'auto'; $('rhythm-grid').options[0].textContent = '自动';
  busy(true);
  try {
    const meta = await runWorker('inspect', file); if (version !== viewVersion) return;
    $('part-count').textContent = `(${meta.parts.length})`;
    $('part-list').append(...meta.parts.map(partLabel));
    const error = await convert(version);
    const inputs = [...$('part-list').querySelectorAll('input')];
    if (error?.code === 'too-many-staves' && inputs.length > AUTO_PARTS && version === viewVersion) {
      inputs.forEach((input, i) => input.checked = i < AUTO_PARTS);
      toast(`这个文件有 ${inputs.length} 个声部，已先显示前 ${AUTO_PARTS} 个。可在“显示声部”中调整。`);
      await convert(version);
    }
  } catch (e) { if (version === viewVersion) showError(e); } finally { busy(false); }
}
function setExport(enabled) { $('export-xml').disabled = !enabled; $('export-pdf').disabled = !enabled; }
function showError(error) {
  converted = null; setExport(false); $('score').replaceChildren();
  const p = document.createElement('p'); p.className = 'error-panel'; p.textContent = explain(error); $('score').append(p);
  $('score-meta').textContent = '请调整声部或节奏精度后重试。'; $('score-warnings').hidden = true;
}
/* Converts the open file with the current options. Returns the error, if any, after showing it. */
async function convert(parentVersion) {
  if (!current) return null;
  const version = parentVersion ?? ++viewVersion, file = current;
  converted = null; setExport(false); busy(true, '正在排版五线谱…');
  try {
    const options = {
      grid: $('rhythm-grid').value === 'auto' ? 'auto' : Number($('rhythm-grid').value), key: $('key-select').value,
      triplets: $('opt-triplets').checked, simplify: $('opt-simplify').checked ? 'auto' : false, // auto: only parts that were played, not step-entered
      parts: [...$('part-list').querySelectorAll('input:checked')].map(x => x.value)
    };
    const result = await runWorker('convert', file, options, file.name);
    if (version !== viewVersion || current?.id !== file.id) return null;
    // Rendering runs in the document because ABCJS needs SVG DOM APIs.
    const rendered = ABCJS.renderAbc('score', result.abc, {responsive: 'resize', staffwidth: 900, paddingtop: 20, paddingbottom: 24, add_classes: true});
    if (!rendered.length || !$('score').querySelector('svg')) throw Error('乐谱排版失败，请尝试其他节奏精度。');
    converted = result; setExport(true);
    $('rhythm-grid').options[0].textContent = result.autoGrid ? `自动（${gridLabel[result.grid]}）` : '自动';
    $('score-meta').textContent = `${result.staves} 个谱表 · ${result.measures} 小节 · ${result.meter.numerator}/${result.meter.denominator} 拍 · ♩ = ${result.tempo} · ${keyLabel(result.key)}`;
    const warnings = result.warnings.map(explain);
    $('score-warnings').textContent = warnings.join(' '); $('score-warnings').hidden = !warnings.length;
    document.title = `${file.name} · Staves`;
    return null;
  } catch (e) { if (version === viewVersion) showError(e); return e; } finally { busy(false); }
}
function exportXML() {
  if (!converted || !current) return;
  const blob = new Blob([converted.xml], {type: 'application/vnd.recordare.musicxml+xml'}), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = current.name.replace(/[\\/:*?"<>|]/g, '-') + '.musicxml';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('MusicXML 已导出。可在浏览器下载列表中找到。');
}
function showHelp() { if (!$('help-dialog').open) $('help-dialog').showModal(); }

/* ---------- Wiring ---------- */

for (let fifths = -7; fifths <= 7; fifths++) {
  const option = document.createElement('option'); option.value = fifths;
  const count = fifths ? `${Math.abs(fifths)}${fifths > 0 ? '♯' : '♭'}` : '无升降号';
  option.textContent = `${keyLabel({fifths, minor: false})} / ${keyLabel({fifths, minor: true})}（${count}）`;
  $('key-select').append(option);
}
$('export-xml').addEventListener('click', exportXML);
$('export-pdf').addEventListener('click', () => {
  if (!converted) return;
  toast('请在打印界面选择“另存为 PDF”。iPhone 可从打印预览分享或存储文件。'); window.print();
});
for (const id of ['rhythm-grid', 'key-select', 'opt-triplets', 'opt-simplify']) $(id).addEventListener('change', () => convert());
$('file-input').addEventListener('change', e => importFiles(e.target.files));
for (const b of document.querySelectorAll('.import-trigger')) b.addEventListener('click', () => $('file-input').click());
const zone = $('dropzone');
zone.addEventListener('click', () => $('file-input').click());
zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); } });
for (const event of ['dragenter', 'dragover']) zone.addEventListener(event, e => { e.preventDefault(); zone.classList.add('dragging'); });
for (const event of ['dragleave', 'drop']) zone.addEventListener(event, e => { e.preventDefault(); zone.classList.remove('dragging'); });
zone.addEventListener('drop', e => importFiles(e.dataTransfer.files));
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
$('sample-button').addEventListener('click', async () => {
  try {
    const response = await fetch('assets/First-light.mid'); if (!response.ok) throw Error('示例暂时无法加载，请重试。');
    await importFiles([new File([await response.arrayBuffer()], 'First light.mid', {type: 'audio/midi'})]);
  } catch (e) { toast(explain(e), true); }
});
$('help-button').addEventListener('click', showHelp); $('help-mobile').addEventListener('click', showHelp);
$('close-help').addEventListener('click', () => $('help-dialog').close());
$('help-dialog').addEventListener('click', e => {
  if (e.target !== $('help-dialog')) return;
  const rect = $('help-dialog').getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) $('help-dialog').close();
});
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('install-button').hidden = false; });
$('install-button').addEventListener('click', async () => { if (installPrompt) { await installPrompt.prompt(); installPrompt = null; $('install-button').hidden = true; } });
function connectivity() {
  if (!navigator.onLine) $('offline-status').textContent = '当前离线';
  else $('offline-status').textContent = navigator.serviceWorker?.controller ? '离线已就绪' : '本地转换';
}
window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity);
async function start() {
  busy(true, '正在打开本地乐谱库…');
  try { createWorker(); } catch { toast('无法启动后台转换，请使用最新版本的浏览器。', true); }
  try { db = await openDB(); files = await dbAction('readonly', s => s.getAll()); }
  catch { db = null; toast('当前浏览器无法持久保存文件。本次仍可转换，请及时导出。', true); document.querySelector('.local-badge').textContent = '仅在本次会话中保留'; }
  libraryView(); connectivity(); document.body.dataset.ready = 'true'; busy(false);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => connectivity()).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', connectivity);
  }
}
start();
