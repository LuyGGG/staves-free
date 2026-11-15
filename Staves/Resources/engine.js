/* Staves MIDI and notation core.
 *
 * Platform-independent: no DOM, no network access. The same file runs in a
 * browser, a Web Worker, WKWebView and Node.js. This copy is the source of
 * truth; `npm run sync` copies it to web/assets/engine.js.
 *
 * Pipeline: parseMIDI (bytes -> parts with instruments) -> buildScore
 * (quantize, split into staves and voices, lay out measures) -> toABC /
 * toMusicXML.
 */
(function (root) {
'use strict';

const LIMITS = {tracks: 256, events: 1000000, notes: 30000, staves: 32, measures: 1000};

/* ---------- Errors and warnings ---------- */

const MESSAGES = {
  'not-midi': 'Choose a Standard MIDI file (.mid or .midi).',
  'bad-header': 'Invalid MIDI header.',
  'format-2': 'MIDI format 2 contains independent sequences. Save it as format 0 or 1 first.',
  'smpte': 'SMPTE time-based MIDI is not supported. Export using musical ticks per beat.',
  'track-count': 'Invalid or excessive MIDI track count.',
  'too-many-events': 'This MIDI file has too many events to display safely.',
  'invalid-event': 'This MIDI file contains invalid event data.',
  'no-notes': 'This MIDI file contains no notes.',
  'too-many-notes': 'This file exceeds the 30,000-note limit. Split it into smaller files.',
  'bad-grid': 'Invalid quantization.',
  'bad-key': 'Invalid key signature.',
  'meter-too-fine': 'Choose a finer quantization for this time signature.',
  'no-parts': 'Select at least one part.',
  'too-many-staves': 'This selection needs more than 32 staves. Select fewer parts.',
  'too-many-measures': 'This score exceeds 1,000 measures. Split the MIDI file first.',
  // Warnings.
  'truncated': 'The file is incomplete; only the readable part was converted.',
  'corrupt-track': 'A track contains invalid data; conversion stopped at that point in the track.',
  'unclosed-notes': 'Unclosed notes were ended at the end of their track.',
  'pitch-bend': 'Pitch bends are not reflected in the written pitches.',
  'sustain-pedal': 'Sustain-pedal extensions are not included; notation uses note-on and note-off durations.',
  'percussion-mapped': 'Percussion is written on a simplified five-line drum staff.',
  'tempo-varies': 'The tempo changes continuously; only the opening tempo is shown.',
  'free-timing': 'Many notes fall between the grid positions, as in a recording of a live performance. The written rhythm is approximate.'
};

class StavesError extends Error {
  constructor(code) {
    super(MESSAGES[code] || code);
    this.name = 'StavesError';
    this.code = code;
  }
}
const fail = code => { throw new StavesError(code); };

/* ---------- General MIDI instruments ---------- */

const GM_NAMES = ('Acoustic Grand Piano|Bright Acoustic Piano|Electric Grand Piano|Honky-tonk Piano|Electric Piano 1|Electric Piano 2|Harpsichord|Clavinet|' +
  'Celesta|Glockenspiel|Music Box|Vibraphone|Marimba|Xylophone|Tubular Bells|Dulcimer|' +
  'Drawbar Organ|Percussive Organ|Rock Organ|Church Organ|Reed Organ|Accordion|Harmonica|Tango Accordion|' +
  'Acoustic Guitar (nylon)|Acoustic Guitar (steel)|Electric Guitar (jazz)|Electric Guitar (clean)|Electric Guitar (muted)|Overdriven Guitar|Distortion Guitar|Guitar Harmonics|' +
  'Acoustic Bass|Electric Bass (finger)|Electric Bass (pick)|Fretless Bass|Slap Bass 1|Slap Bass 2|Synth Bass 1|Synth Bass 2|' +
  'Violin|Viola|Cello|Contrabass|Tremolo Strings|Pizzicato Strings|Orchestral Harp|Timpani|' +
  'String Ensemble 1|String Ensemble 2|Synth Strings 1|Synth Strings 2|Choir Aahs|Voice Oohs|Synth Voice|Orchestra Hit|' +
  'Trumpet|Trombone|Tuba|Muted Trumpet|French Horn|Brass Section|Synth Brass 1|Synth Brass 2|' +
  'Soprano Sax|Alto Sax|Tenor Sax|Baritone Sax|Oboe|English Horn|Bassoon|Clarinet|' +
  'Piccolo|Flute|Recorder|Pan Flute|Blown Bottle|Shakuhachi|Whistle|Ocarina|' +
  'Lead 1 (square)|Lead 2 (sawtooth)|Lead 3 (calliope)|Lead 4 (chiff)|Lead 5 (charang)|Lead 6 (voice)|Lead 7 (fifths)|Lead 8 (bass + lead)|' +
  'Pad 1 (new age)|Pad 2 (warm)|Pad 3 (polysynth)|Pad 4 (choir)|Pad 5 (bowed)|Pad 6 (metallic)|Pad 7 (halo)|Pad 8 (sweep)|' +
  'FX 1 (rain)|FX 2 (soundtrack)|FX 3 (crystal)|FX 4 (atmosphere)|FX 5 (brightness)|FX 6 (goblins)|FX 7 (echoes)|FX 8 (sci-fi)|' +
  'Sitar|Banjo|Shamisen|Koto|Kalimba|Bagpipe|Fiddle|Shanai|' +
  'Tinkle Bell|Agogo|Steel Drums|Woodblock|Taiko Drum|Melodic Tom|Synth Drum|Reverse Cymbal|' +
  'Guitar Fret Noise|Breath Noise|Seashore|Bird Tweet|Telephone Ring|Helicopter|Applause|Gunshot').split('|');

const GM_NAMES_ZH = ('大钢琴|明亮钢琴|电声大钢琴|酒吧钢琴|电钢琴 1|电钢琴 2|羽管键琴|击弦古钢琴|' +
  '钢片琴|钟琴|八音盒|颤音琴|马林巴|木琴|管钟|扬琴|' +
  '拉杆风琴|打击风琴|摇滚风琴|管风琴|簧风琴|手风琴|口琴|探戈手风琴|' +
  '尼龙弦吉他|钢弦吉他|爵士电吉他|清音电吉他|闷音电吉他|过载吉他|失真吉他|吉他泛音|' +
  '原声贝斯|指弹电贝斯|拨片电贝斯|无品贝斯|击弦贝斯 1|击弦贝斯 2|合成贝斯 1|合成贝斯 2|' +
  '小提琴|中提琴|大提琴|低音提琴|弦乐震音|弦乐拨奏|竖琴|定音鼓|' +
  '弦乐合奏 1|弦乐合奏 2|合成弦乐 1|合成弦乐 2|合唱“啊”|人声“哦”|合成人声|管弦乐齐奏|' +
  '小号|长号|大号|弱音小号|圆号|铜管组|合成铜管 1|合成铜管 2|' +
  '高音萨克斯|中音萨克斯|次中音萨克斯|上低音萨克斯|双簧管|英国管|大管|单簧管|' +
  '短笛|长笛|竖笛|排箫|吹瓶|尺八|口哨|陶笛|' +
  '合成主音 1（方波）|合成主音 2（锯齿波）|合成主音 3（汽笛风琴）|合成主音 4（吹管）|合成主音 5（夏朗）|合成主音 6（人声）|合成主音 7（五度）|合成主音 8（贝斯加主音）|' +
  '合成铺底 1（新世纪）|合成铺底 2（温暖）|合成铺底 3（复音）|合成铺底 4（合唱）|合成铺底 5（弓弦）|合成铺底 6（金属）|合成铺底 7（光环）|合成铺底 8（扫掠）|' +
  '音效 1（雨）|音效 2（音轨）|音效 3（水晶）|音效 4（氛围）|音效 5（明亮）|音效 6（小妖精）|音效 7（回声）|音效 8（科幻）|' +
  '西塔尔|班卓琴|三味线|日本筝|卡林巴|风笛|民间提琴|山奈唢呐|' +
  '叮当铃|阿哥哥铃|钢鼓|木鱼|太鼓|旋律嗵鼓|合成鼓|反向镲|' +
  '吉他品噪|呼吸声|海浪|鸟鸣|电话铃|直升机|掌声|枪声').split('|');

const GM_FAMILIES = ['Piano', 'Chromatic Percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reed', 'Pipe', 'Synth Lead', 'Synth Pad', 'Synth Effects', 'Ethnic', 'Percussive', 'Sound Effects'];
const GM_FAMILIES_ZH = ['钢琴', '色彩打击乐', '风琴', '吉他', '贝斯', '弦乐', '合奏', '铜管',
  '簧管', '笛类', '合成主音', '合成铺底', '合成音效', '民族乐器', '打击乐器', '音效'];

/* When a channel has no Program Change, the track name is the only clue. Order matters. */
const NAME_HINTS = [
  [/contrabass|double\s*bass|upright\s*bass|低音提琴|倍大提琴/i, 43],
  [/bassoon|fagott|大管|巴松/i, 70],
  [/bass\s*guitar|e(lectric|\.)?\s*bass|\bbass\b|贝斯|贝司/i, 33],
  [/harpsichord|cembalo|羽管键琴/i, 6],
  [/piano|klavier|\bpno\b|钢琴/i, 0],
  [/violin|\bvln\b|小提琴/i, 40],
  [/viola|\bvla\b|中提琴/i, 41],
  [/cello|\bvc\b|大提琴/i, 42],
  [/harp|竖琴/i, 46],
  [/piccolo|短笛/i, 72],
  [/flute|fl[oö]te|长笛/i, 73],
  [/oboe|双簧管/i, 68],
  [/clarinet|klarinette|单簧管|黑管/i, 71],
  [/english\s*horn|cor\s*anglais|英国管/i, 69],
  [/trumpet|trompete|小号/i, 56],
  [/trombone|posaune|长号/i, 57],
  [/tuba|大号/i, 58],
  [/horn|圆号/i, 60],
  [/soprano\s*sax/i, 64], [/tenor\s*sax/i, 66], [/bari(tone)?\s*sax/i, 67], [/sax|萨克斯/i, 65],
  [/accordion|手风琴/i, 21],
  [/organ|orgel|风琴/i, 19],
  [/guitar|gitarre|\bgtr\b|吉他/i, 24],
  [/strings|streicher|弦乐/i, 48],
  [/choir|chorus|vocal|voice|合唱|人声/i, 52],
  [/timpani|定音鼓/i, 47],
  [/marimba|马林巴/i, 12], [/vibra|颤音琴/i, 11], [/xylo|木琴/i, 13], [/glock|钟琴/i, 9], [/celest|钢片琴/i, 8]
];

function instrumentName(program, lang) {
  if (program == null || program < 0 || program > 127) return lang === 'zh' ? '打击乐（鼓组）' : 'Percussion';
  return (lang === 'zh' ? GM_NAMES_ZH : GM_NAMES)[program];
}
function instrumentFamily(program, lang) {
  if (program == null || program < 0 || program > 127) return lang === 'zh' ? '打击乐' : 'Percussion';
  return (lang === 'zh' ? GM_FAMILIES_ZH : GM_FAMILIES)[program >> 3];
}

/* General MIDI percussion key map: name, staff position and notehead on a five-line drum staff. */
const DRUM_NAMES = ('Acoustic Bass Drum|Bass Drum 1|Side Stick|Acoustic Snare|Hand Clap|Electric Snare|Low Floor Tom|Closed Hi-Hat|High Floor Tom|Pedal Hi-Hat|' +
  'Low Tom|Open Hi-Hat|Low-Mid Tom|Hi-Mid Tom|Crash Cymbal 1|High Tom|Ride Cymbal 1|Chinese Cymbal|Ride Bell|Tambourine|Splash Cymbal|Cowbell|Crash Cymbal 2|Vibraslap|' +
  'Ride Cymbal 2|Hi Bongo|Low Bongo|Mute Hi Conga|Open Hi Conga|Low Conga|High Timbale|Low Timbale|High Agogo|Low Agogo|Cabasa|Maracas|Short Whistle|Long Whistle|' +
  'Short Guiro|Long Guiro|Claves|Hi Wood Block|Low Wood Block|Mute Cuica|Open Cuica|Mute Triangle|Open Triangle').split('|'); // keys 35..81
const DRUM_STAFF = {
  35: 'F4', 36: 'F4', 37: 'C5x', 38: 'C5', 39: 'C5x', 40: 'C5', 41: 'A4', 43: 'A4', 45: 'D5', 47: 'D5', 48: 'E5', 50: 'E5',
  42: 'G5x', 46: 'G5x', 44: 'D4x', 49: 'A5x', 57: 'A5x', 52: 'A5x', 55: 'A5x', 51: 'F5x', 59: 'F5x', 53: 'F5x'
};
function drumName(key) { return DRUM_NAMES[key - 35] || `Percussion ${key}`; }
function drumDisplay(key) {
  const spec = DRUM_STAFF[key] || 'B4x';
  return {step: spec[0], octave: Number(spec[1]), head: spec[2] === 'x' ? 'x' : 'normal'};
}

/* ---------- MIDI parsing ---------- */

function decodeText(bytes) {
  let ascii = true, gb2312 = true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] < 0x80) continue;
    ascii = false;
    // GB2312-style double bytes: both in A1..FE. Isolated high bytes suggest Latin-1 instead.
    if (bytes[i] >= 0xA1 && i + 1 < bytes.length && bytes[i + 1] >= 0xA1) i++; else gb2312 = false;
  }
  let text;
  if (!ascii && typeof TextDecoder !== 'undefined') {
    for (const encoding of gb2312 ? ['utf-8', 'gbk'] : ['utf-8']) {
      try { text = new TextDecoder(encoding, {fatal: true}).decode(bytes); break; } catch (e) { /* try the next encoding */ }
    }
  }
  if (text === undefined) { text = ''; for (const b of bytes) text += String.fromCharCode(b); } // ASCII or Latin-1
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function parseMIDI(input, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en'; // language of names the file does not provide
  const a = input instanceof Uint8Array ? input : new Uint8Array(input);
  let p = 0, limit = a.length, events = 0;
  const need = n => { if (p + n > limit) fail('truncated'); };
  const byte = () => { need(1); return a[p++]; };
  const u16 = () => byte() * 256 + byte();
  const u32 = () => byte() * 16777216 + byte() * 65536 + byte() * 256 + byte();
  const tag = at => String.fromCharCode(a[at], a[at + 1], a[at + 2], a[at + 3]);
  const vlq = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) { const b = byte(); v = v * 128 + (b & 127); if (!(b & 128)) return v; }
    return fail('invalid-event');
  };

  // Some files are wrapped in a RIFF "RMID" container; the MIDI data starts a few bytes in.
  if (a.length >= 24 && tag(0) === 'RIFF' && tag(8) === 'RMID') {
    for (let i = 12; i <= Math.min(64, a.length - 4); i++) if (tag(i) === 'MThd') { p = i; break; }
  }
  if (a.length - p < 14 || tag(p) !== 'MThd') fail('not-midi');
  p += 4;
  const headerLength = u32();
  if (headerLength < 6 || p + headerLength > a.length) fail('bad-header');
  const format = u16(), trackCount = u16(), division = u16();
  p += headerLength - 6;
  if (format > 1) fail('format-2');
  if (!division || division & 0x8000) fail('smpte');
  if (!trackCount || trackCount > LIMITS.tracks) fail('track-count');

  const warnings = new Set(), meters = [], tempos = [], keys = [], programs = [], tracks = [];
  let corrupt = false, trackIndex = 0;
  while (p + 8 <= a.length && trackIndex < trackCount) {
    limit = a.length;
    const id = tag(p); p += 4;
    const length = u32();
    let end = p + length;
    if (end > a.length) { end = a.length; warnings.add('truncated'); }
    if (id !== 'MTrk') { p = end; continue; } // unknown chunks are skipped, as the specification requires
    limit = end;
    const t = trackIndex++;
    let tick = 0, running = 0, name = '', instrumentText = '', port = 0;
    const active = new Map(), notes = [];
    const close = (key, at) => {
      const queue = active.get(key);
      if (queue && queue.length) { const n = queue.shift(); n.duration = Math.max(1, at - n.start); notes.push(n); }
    };
    try {
      while (p < end) {
        if (++events > LIMITS.events) fail('too-many-events');
        tick += vlq();
        let status = byte();
        // Running status. Strictly, meta and SysEx events cancel it, but real files rely on it surviving.
        if (status < 0x80) { if (!running) fail('invalid-event'); p--; status = running; }
        else if (status < 0xF0) running = status;
        if (status === 0xFF) {
          const type = byte(), n = vlq(); need(n);
          const d = a.subarray(p, p + n); p += n;
          if (type === 0x03 && !name) name = decodeText(d);
          else if (type === 0x04 && !instrumentText) instrumentText = decodeText(d);
          else if (type === 0x51 && n === 3) { const us = d[0] * 65536 + d[1] * 256 + d[2]; if (us) tempos.push({tick, bpm: 60000000 / us}); }
          else if (type === 0x58 && n >= 2) { if (d[0] && d[1] <= 6) meters.push({tick, numerator: d[0], denominator: 2 ** d[1]}); }
          else if (type === 0x59 && n >= 2) { const fifths = d[0] > 127 ? d[0] - 256 : d[0]; if (Math.abs(fifths) <= 7) keys.push({tick, fifths, minor: d[1] === 1}); }
          else if (type === 0x21 && n === 1) port = d[0];
          else if (type === 0x2F) break;
          continue;
        }
        if (status === 0xF0 || status === 0xF7) { const n = vlq(); need(n); p += n; continue; }
        if (status >= 0xF0) fail('invalid-event');
        const kind = status >> 4, channel = status & 15, x = byte();
        const y = kind === 12 || kind === 13 ? 0 : byte();
        if (x > 127 || y > 127) fail('invalid-event');
        const key = channel * 128 + x;
        if (kind === 9 && y) {
          if (!active.has(key)) active.set(key, []);
          active.get(key).push({pitch: x, start: tick, duration: 0, velocity: y, channel});
        } else if (kind === 8 || kind === 9) close(key, tick);
        else if (kind === 12) programs.push({tick, channel, program: x, order: events, track: t});
        else if (kind === 14 && (x !== 0 || y !== 64)) warnings.add('pitch-bend');
        else if (kind === 11 && x === 64 && y >= 64) warnings.add('sustain-pedal');
      }
    } catch (error) {
      if (error.code === 'truncated') warnings.add('truncated');
      else if (error.code === 'invalid-event') { corrupt = true; warnings.add('corrupt-track'); }
      else throw error;
    }
    for (const [key, queue] of active) {
      if (queue.length) warnings.add('unclosed-notes');
      while (queue.length) close(key, tick);
    }
    tracks.push({index: t, name, instrumentText, port, notes});
    p = end;
  }
  if (trackIndex < trackCount) warnings.add('truncated');

  // The instrument of a note is the latest Program Change on its channel: first within its own track,
  // otherwise anywhere in the file. Files that address several MIDI ports reuse channel numbers for
  // unrelated instruments, so the file-wide fallback is only safe when a single port is used.
  programs.sort((x, y) => x.tick - y.tick || x.order - y.order);
  const singlePort = new Set(tracks.map(track => track.port)).size <= 1;
  const own = new Map(), shared = new Map();
  for (const change of programs) {
    for (const [index, id] of [[own, `${change.track}:${change.channel}`], [shared, change.channel]]) {
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(change);
    }
  }
  const programAt = (track, channel, tick) => {
    const list = own.get(`${track}:${channel}`) || (singlePort && shared.get(channel)) || [];
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].tick <= tick) lo = mid + 1; else hi = mid; }
    return lo ? list[lo - 1].program : -1;
  };

  const parts = [];
  for (const track of tracks) {
    const groups = new Map();
    for (const n of track.notes) {
      const id = `${track.index}-${n.channel}`;
      if (!groups.has(id)) groups.set(id, {id, track: track.index, channel: n.channel, percussion: n.channel === 9, votes: new Map(), notes: []});
      const group = groups.get(id), program = programAt(track.index, n.channel, n.start);
      group.votes.set(program, (group.votes.get(program) || 0) + 1);
      group.notes.push({pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity});
    }
    const label = track.name || track.instrumentText;
    // A track that plays on several channels: in a format 1 file it is one player switching sounds
    // (arco and pizzicato), so the channel with most notes keeps the track name and the others add
    // their sound to it. In a format 0 file the only track's name is the title of the piece.
    const largest = Math.max(...[...groups.values()].map(group => group.notes.length));
    const main = format === 1 && label ? [...groups.values()].find(group => group.notes.length === largest) : null;
    for (const group of groups.values()) {
      // A channel may switch sounds (arco/pizzicato); the part keeps the sound most of its notes use.
      let program = [...group.votes].sort((x, y) => y[1] - x[1])[0][0], source = 'program';
      if (group.percussion) { program = null; source = 'percussion'; }
      else if (program < 0) {
        const hint = NAME_HINTS.find(([pattern]) => pattern.test(label));
        program = hint ? hint[1] : 0;
        source = hint ? 'name' : 'default';
      }
      group.notes.sort((x, y) => x.start - y.start || x.pitch - y.pitch);
      let low = 127, high = 0;
      for (const n of group.notes) { if (n.pitch < low) low = n.pitch; if (n.pitch > high) high = n.pitch; }
      parts.push({
        id: group.id, track: group.track, channel: group.channel, percussion: group.percussion,
        trackName: track.name,
        name: groups.size === 1 ? label || instrumentName(program, lang)
          : !main ? instrumentName(program, lang)
          : group === main ? label : `${label} · ${instrumentName(program, lang)}`,
        instrument: {program, name: instrumentName(program), label: instrumentName(program, lang), family: instrumentFamily(program), source},
        low, high, notes: group.notes
      });
    }
  }
  if (!parts.length) fail(corrupt ? 'invalid-event' : 'no-notes');
  if (parts.reduce((sum, part) => sum + part.notes.length, 0) > LIMITS.notes) fail('too-many-notes');
  const seen = new Map();
  for (const part of parts) { // make display names unique
    const count = (seen.get(part.name) || 0) + 1;
    seen.set(part.name, count);
    if (count > 1) part.name += ` (${count})`;
  }
  if (parts.some(part => part.percussion)) warnings.add('percussion-mapped');

  const byTick = list => list.sort((x, y) => x.tick - y.tick);
  byTick(meters); byTick(tempos); byTick(keys);
  const opening = (list, fallback) => { let found = null; for (const item of list) if (item.tick <= 0) found = item; return found || list[0] || fallback; };

  // Key: trust the file, except that a lone "C major" is usually an exporter default.
  const estimate = estimateKey(parts, division);
  let key;
  if (keys.length) {
    const first = opening(keys);
    key = {fifths: first.fifths, minor: first.minor, source: 'file'};
    if (estimate && keys.length === 1 && !first.fifths && !first.minor && estimate.fifths &&
        estimate.coverage - estimate.coverageOfC > 0.08) key = {fifths: estimate.fifths, minor: estimate.minor, source: 'estimated'};
  } else key = estimate ? {fifths: estimate.fifths, minor: estimate.minor, source: 'estimated'} : {fifths: 0, minor: false, source: 'default'};

  const meter = opening(meters, {numerator: 4, denominator: 4});
  return {
    division, format, parts, meters, tempos, keys: key.source === 'file' ? keys : [],
    meter: {numerator: meter.numerator, denominator: meter.denominator},
    tempo: Math.round(opening(tempos, {bpm: 120}).bpm),
    key,
    warnings: [...warnings].map(code => ({code, message: MESSAGES[code]}))
  };
}

/* ---------- Key estimation and pitch spelling ---------- */

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/* Krumhansl-Schmuckler key finding over duration-weighted pitch classes. */
function estimateKey(parts, division) {
  const weights = new Array(12).fill(0);
  let count = 0;
  for (const part of parts) {
    if (part.percussion) continue;
    for (const n of part.notes) { weights[n.pitch % 12] += Math.min(n.duration, division * 2); count++; }
  }
  if (count < 12 || weights.filter(Boolean).length < 4) return null;
  const correlate = (profile, tonic) => {
    let meanW = 0, meanP = 0;
    for (let i = 0; i < 12; i++) { meanW += weights[i] / 12; meanP += profile[i] / 12; }
    let top = 0, w2 = 0, p2 = 0;
    for (let i = 0; i < 12; i++) {
      const w = weights[(i + tonic) % 12] - meanW, q = profile[i] - meanP;
      top += w * q; w2 += w * w; p2 += q * q;
    }
    return top / Math.sqrt(w2 * p2 || 1);
  };
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const score = correlate(minor ? MINOR_PROFILE : MAJOR_PROFILE, tonic);
      if (!best || score > best.score) best = {tonic, minor, score};
    }
  }
  let fifths = ((best.minor ? best.tonic + 3 : best.tonic) * 7) % 12;
  if (fifths > 6) fifths -= 12;
  const total = weights.reduce((x, y) => x + y, 0);
  const coverage = f => { // share of sounding time that is diatonic in the signature with f sharps
    const tonic = ((f * 7) % 12 + 12) % 12;
    return [0, 2, 4, 5, 7, 9, 11].reduce((sum, degree) => sum + weights[(tonic + degree) % 12], 0) / total;
  };
  return {fifths, minor: best.minor, coverage: coverage(fifths), coverageOfC: coverage(0)};
}

const STEPS = 'FCGDAEB';
const STEP_PITCH = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11};

/* Spell a MIDI pitch for a key signature using its position on the line of fifths. */
function spell(midiPitch, key) {
  const low = key.fifths + (key.minor ? -3 : -5); // 12-wide window: major b2..#4, minor b5..#7
  let position = (midiPitch % 12) * 7 % 12;
  position += 12 * Math.ceil((low - position) / 12);
  if (position > 12) position -= 12; // never beyond B sharp
  if (position < -8) position += 12; // never beyond F flat
  const step = STEPS[((position + 1) % 7 + 7) % 7], alter = Math.floor((position + 1) / 7);
  return {step, alter, octave: Math.floor((midiPitch - alter) / 12) - 1};
}

const MAJOR_KEYS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const MINOR_KEYS = ['Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m'];
function keyName(key) { return (key.minor ? MINOR_KEYS : MAJOR_KEYS)[key.fifths + 7] || 'C'; }

/* ---------- Score building ---------- */

/* Measures are created on demand, so time-signature changes are honoured at the next bar line. */
function measureMap(midi, grid, U) {
  const perTick = U / midi.division;
  const changes = midi.meters.map(m => ({unit: m.tick * perTick, meter: {numerator: m.numerator, denominator: m.denominator}}));
  const list = [];
  let next = 0, meter = {numerator: 4, denominator: 4};
  const extend = () => {
    const start = list.length ? list[list.length - 1].end : 0;
    while (next < changes.length && changes[next].unit <= start + U / 2) meter = changes[next++].meter;
    const steps = meter.numerator * grid / meter.denominator;
    if (!Number.isInteger(steps) || steps < 1) fail('meter-too-fine');
    const length = steps * 3, per = 4 * U / meter.denominator;
    let compound = meter.numerator % 3 === 0 && meter.numerator >= 6 && meter.denominator >= 8;
    let beat = compound ? per * 3 : per;
    if (!Number.isInteger(beat) || beat % 3 || beat > length) { beat = length; compound = false; }
    if (list.length > LIMITS.measures + 4) fail('too-many-measures'); // a stray far-away note must not loop forever
    list.push({index: list.length, start, end: start + length, length, meter, beat, compound,
      quarterBased: !compound && meter.denominator <= 4});
  };
  const at = unit => {
    while (!list.length || list[list.length - 1].end <= unit) extend();
    let lo = 0, hi = list.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (list[mid].start <= unit) lo = mid; else hi = mid - 1; }
    return list[lo];
  };
  return {list, at};
}

/* Find quarter-note beats whose onsets sit on an eighth-triplet grid rather than a binary one. The
 * binary alternative is sixteenth notes, whatever the chosen grid: measured against a finer one, a
 * triplet played a few milliseconds off would pass for thirty-second notes. Notes that sit exactly
 * on the chosen grid are still believed. */
function tripletSpans(notes, map, perTick, U) {
  const TRI = U / 3, BIN = U / 4, stats = new Map();
  for (const n of notes) {
    const u = n.start * perTick, m = map.at(u + 1.5);
    if (!m.quarterBased) continue;
    const span = m.start + Math.floor((u + 1.5 - m.start) / U) * U, rel = u - span;
    const fine = Math.abs(rel - Math.round(rel / BIN) * BIN), index = Math.round(rel / TRI);
    const s = stats.get(span) || {binary: 0, triplet: 0, grid: 0, interior: 0};
    s.binary += fine; s.triplet += Math.abs(rel - index * TRI); s.grid += Math.abs(rel - Math.round(rel / 3) * 3);
    if (index === 1 || index === 2) s.interior++;
    stats.set(span, s);
  }
  const spans = new Set();
  for (const [span, s] of stats) if (s.interior && s.triplet * 2 < s.binary && s.grid * 4 >= s.triplet) spans.add(span);
  return spans;
}

/* Remove duplicates and stop a note when the same pitch is struck again. */
function cleanOverlaps(notes) {
  notes.sort((x, y) => x.pitch - y.pitch || x.start - y.start || y.end - x.end);
  const out = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    if (last && last.pitch === n.pitch) {
      if (last.start === n.start) continue;
      if (last.end > n.start) last.end = n.start;
    }
    out.push(n);
  }
  return out.sort((x, y) => x.start - y.start || x.pitch - y.pitch);
}

function firstAtLeast(sorted, value) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < value) lo = mid + 1; else hi = mid; }
  return sorted[lo];
}

/* Performances overlap legato notes and release others early. Written music does neither. */
function tidyDurations(notes, map, U) {
  const gap = U / 4, onsets = [...new Set(notes.map(n => n.start))].sort((x, y) => x - y);
  for (const n of notes) {
    const following = firstAtLeast(onsets, n.start + 1);
    if (following !== undefined && n.end > following && n.end - following <= gap && n.end - following < following - n.start) n.end = following;
    const next = firstAtLeast(onsets, n.end), length = n.end - n.start;
    if (next !== undefined && next > n.end && next - n.end <= gap && next - n.end <= length) { n.end = next; continue; }
    const m = map.at(n.end - 1), beat = Math.min(m.end, m.start + Math.ceil((n.end - m.start) / m.beat) * m.beat);
    if (beat > n.end && beat - n.end <= gap && beat - n.end <= length && (next === undefined || next >= beat)) n.end = beat;
  }
}

/* A drum hit has no meaningful length: write it up to the next hit or the end of its beat. */
function drumDurations(notes, map, U) {
  const onsets = [...new Set(notes.map(n => n.start))].sort((x, y) => x - y);
  for (const n of notes) {
    const m = map.at(n.start), size = m.quarterBased ? U : m.beat;
    const beatEnd = Math.min(m.end, m.start + (Math.floor((n.start - m.start) / size) + 1) * size);
    const next = firstAtLeast(onsets, n.start + 1);
    n.end = next === undefined ? beatEnd : Math.min(next, beatEnd);
  }
}

const KEYBOARDS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 16, 17, 18, 19, 20, 21, 23, 46]);
const BASS_CLEF = new Set([32, 33, 34, 35, 36, 37, 38, 39, 42, 43, 47, 57, 58, 67, 70]); // basses, cello, timpani, trombone, tuba, baritone sax, bassoon

/* Decide the staves of a part: a grand staff for keyboard-like material, otherwise one staff. */
function planStaves(part, notes) {
  if (part.percussion) return [{clef: 'perc', notes}];
  const pitches = notes.map(n => n.pitch).sort((x, y) => x - y);
  const median = pitches[pitches.length >> 1], low = pitches[0], high = pitches[pitches.length - 1];
  const below = pitches.filter(x => x < 60).length / pitches.length;
  const program = part.instrument.program;
  const wide = KEYBOARDS.has(program) ? below >= 0.1 && below <= 0.9 : high - low >= 36 && below >= 0.2 && below <= 0.8;
  if (wide) return [{clef: 'treble', notes: notes.filter(n => n.pitch >= 60)}, {clef: 'bass', notes: notes.filter(n => n.pitch < 60)}];
  let clef = median < 60 ? 'bass' : 'treble';
  if (part.instrument.source !== 'default') {
    if (program >= 24 && program <= 31 && median < 64) clef = 'treble-8'; // guitars sound an octave below the staff
    else if (((program >= 32 && program <= 39) || program === 43) && median < 43) clef = 'bass-8';
    else if (program === 41 && median >= 50 && median <= 72) clef = 'alto';
    else if (BASS_CLEF.has(program) && median < 67) clef = 'bass'; // these read bass clef even when playing high
  }
  return [{clef, notes}];
}

const RIGHT_HAND = /right|\brh\b|r\.h\.|右/i, LEFT_HAND = /left|\blh\b|l\.h\.|左/i;

/* Two neighbouring keyboard parts are the two hands of one player when their names say so,
 * or when one is clearly high and the other clearly low. Returns [upper, lower] or null. */
function handsOfOneKeyboard(a, b) {
  const x = a.source, y = b.source;
  if (x.percussion || y.percussion || x.instrument.program !== y.instrument.program || !KEYBOARDS.has(x.instrument.program)) return null;
  if (RIGHT_HAND.test(x.name) && LEFT_HAND.test(y.name)) return [a, b];
  if (LEFT_HAND.test(x.name) && RIGHT_HAND.test(y.name)) return [b, a];
  if (a.below <= 0.35 && b.below >= 0.65) return [a, b];
  if (b.below <= 0.35 && a.below >= 0.65) return [b, a];
  return null;
}

/* Slice simultaneous notes into one voice of chords, tying notes that continue across a slice. */
function chordify(notes) {
  const times = [...new Set(notes.flatMap(n => [n.start, n.end]))].sort((x, y) => x - y);
  const events = [];
  let active = [], next = 0;
  for (let i = 0; i + 1 < times.length; i++) {
    const start = times[i], end = times[i + 1];
    active = active.filter(n => n.end > start);
    while (next < notes.length && notes[next].start <= start) active.push(notes[next++]);
    if (active.length) events.push({start, end, notes: active.map(n => ({pitch: n.pitch, tieIn: n.start < start, tieOut: n.end > end})).sort((x, y) => x.pitch - y.pitch)});
  }
  return events;
}

const MAX_VOICES = 4; // per staff, as in notation software

/* Split a staff into voices. Notes that start and end together form a chord. Wherever chords
 * overlap, each overlapping line gets its own voice (highest first), so a held note is written as
 * one long note rather than a chain of ties. Passages needing more than four voices are chordified. */
function makeVoices(notes, percussive) {
  if (percussive) return [chordify(notes)];
  const groups = new Map();
  for (const n of notes) {
    const id = n.start + ':' + n.end;
    if (!groups.has(id)) groups.set(id, {start: n.start, end: n.end, notes: [], raw: []});
    groups.get(id).notes.push({pitch: n.pitch, tieIn: false, tieOut: false});
    groups.get(id).raw.push(n);
  }
  const ordered = [...groups.values()];
  for (const g of ordered) { g.notes.sort((x, y) => x.pitch - y.pitch); g.top = g.notes[g.notes.length - 1].pitch; }
  ordered.sort((x, y) => x.start - y.start || y.top - x.top);
  const voices = [[]];
  let cluster = [], clusterEnd = -1;
  const flush = () => { // a cluster is a run of chords connected by overlaps
    const lanes = [];
    for (const g of cluster) {
      let lane = null;
      for (const candidate of lanes) {
        if (candidate.end <= g.start && (!lane || Math.abs(candidate.pitch - g.top) < Math.abs(lane.pitch - g.top))) lane = candidate;
      }
      if (!lane) { lane = {events: [], sum: 0}; lanes.push(lane); }
      lane.events.push(g); lane.end = g.end; lane.pitch = g.top; lane.sum += g.top;
    }
    if (lanes.length > MAX_VOICES) voices[0].push(...chordify(cluster.flatMap(g => g.raw)));
    else lanes.sort((x, y) => y.sum / y.events.length - x.sum / x.events.length).forEach((lane, i) => {
      while (voices.length <= i) voices.push([]);
      voices[i].push(...lane.events);
    });
    cluster = [];
  };
  for (const g of ordered) {
    if (cluster.length && g.start >= clusterEnd) flush();
    cluster.push(g);
    clusterEnd = Math.max(cluster.length === 1 ? 0 : clusterEnd, g.end);
  }
  flush();
  return voices;
}

const sameCell = (position, length, cell) => Math.floor(position / cell) === Math.floor((position + length - 1) / cell);

/* Can a note or rest of K grid steps start at step P of this measure without hiding the beat? */
function fits(P, K, m, isRest) {
  const dotted = K % 3 === 0, base = dotted ? K * 2 / 3 : K;
  let rel = P;
  if (m.compound) {
    const B = m.beat / 3;
    if (!sameCell(P, K, B)) return P % B === 0 && K % B === 0;
    rel = P % B;
    if (isRest && K === B) return true;
  }
  if (isRest) return !dotted && rel % K === 0;
  if (dotted) return rel % (base / 2) === 0 && sameCell(rel, K, base * 2);
  return rel % base === 0 || (base >= 2 && rel % (base / 2) === 0 && sameCell(rel, K, base * 2));
}

function writableSteps(grid) {
  const out = [];
  for (let k = 1; k <= 2 * grid; k *= 2) { out.push(k); if (k >= 2 && k <= grid) out.push(k * 1.5); }
  return out.sort((x, y) => y - x);
}

/* Split a binary-grid duration into writable values (plain or dotted), longest first. */
function splitBinary(position, length, m, isRest, candidates) {
  const out = [];
  let P = position / 3, left = length / 3;
  while (left > 0) {
    let best = Math.min(1, left);
    if (Number.isInteger(P) && Number.isInteger(left)) {
      for (const K of candidates) if (K <= left && fits(P, K, m, isRest)) { best = K; break; }
    }
    out.push(best * 3); P += best; left -= best;
  }
  return out;
}

const TYPE_NAMES = {0.5: 'breve', 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd'};

/* Turn a voice's events into measures of written items: notes, rests, ties and triplets. */
function layoutVoice(events, measures, ctx, percussive) {
  const {U, grid, candidates} = ctx, TRI = U / 3, out = [];
  let cursor = 0;
  for (const m of measures) {
    const segments = [];
    let position = m.start;
    while (cursor < events.length && events[cursor].end <= m.start) cursor++;
    for (let k = cursor; k < events.length && events[k].start < m.end; k++) {
      const event = events[k], start = Math.max(event.start, m.start), end = Math.min(event.end, m.end);
      if (start > position) segments.push({start: position, end: start, event: null});
      segments.push({start, end, event});
      position = end;
    }
    if (position < m.end) segments.push({start: position, end: m.end, event: null});
    // An empty measure no longer than a whole note takes the whole-measure rest. `pieces` are the
    // equivalent ordinary rests, for where that symbol cannot be used.
    if (segments.length === 1 && !segments[0].event && m.length / 3 <= grid) {
      out.push([{units: m.length, steps: m.length / 3, rest: true, measureRest: true, notes: null,
        pieces: splitBinary(0, m.length, m, true, candidates).map(units => units / 3)}]);
      continue;
    }
    const triplet = new Set();
    if (m.quarterBased) {
      for (const s of segments) for (const edge of [s.start, s.end]) { const rel = (edge - m.start) % U; if (rel % 3) triplet.add(edge - rel); }
    }
    const items = [];
    for (const s of segments) {
      const pieces = [];
      let x = s.start;
      while (x < s.end) {
        const span = m.quarterBased ? x - (x - m.start) % U : -1;
        if (triplet.has(span) && !(x === span && s.end >= span + U)) {
          const y = Math.min(s.end, span + U);
          pieces.push({units: y - x, span});
          x = y;
        } else {
          let y = s.end;
          if (m.quarterBased) for (let q = span + U; q < s.end; q += U) if (triplet.has(q)) { y = q; break; }
          for (const units of splitBinary(x - m.start, y - x, m, !s.event, candidates)) pieces.push({units, span: -1});
          x = y;
        }
      }
      pieces.forEach((piece, i) => {
        const sounding = s.event && (!percussive || (i === 0 && s.start === s.event.start));
        const item = {units: piece.units, rest: !sounding, notes: null};
        if (piece.span >= 0) {
          item.tuplet = piece.span;
          item.type = piece.units === TRI ? 'eighth' : 'quarter';
          item.steps = (piece.units / TRI) * grid / 8; // written (not sounding) length in grid steps
          item.dots = 0;
        } else {
          const steps = piece.units / 3, dotted = steps % 3 === 0;
          item.steps = steps;
          item.dots = dotted ? 1 : 0;
          item.type = TYPE_NAMES[grid / (dotted ? steps * 2 / 3 : steps)] || 'quarter';
        }
        if (sounding) {
          const first = i === 0, last = i === pieces.length - 1;
          item.notes = s.event.notes.map(n => ({
            pitch: n.pitch,
            tieIn: !percussive && (!first || s.start > s.event.start || n.tieIn),
            tieOut: !percussive && (!last || s.end < s.event.end || n.tieOut)
          }));
        }
        items.push(item);
      });
    }
    for (let i = 0; i < items.length; i++) { // bracket each triplet group
      if (items[i].tuplet === undefined) continue;
      let j = i;
      while (j + 1 < items.length && items[j + 1].tuplet === items[i].tuplet) j++;
      items[i].tupletStart = j - i + 1;
      items[j].tupletStop = true;
      i = j;
    }
    out.push(items);
  }
  return out;
}

const offGrid = (tick, step) => { const rest = tick % step; return Math.min(rest, step - rest); };

/* Count the note onsets that miss each grid by more than a rounding error. Notes on eighth-triplet
 * positions are counted apart: they fit every grid when triplets are recognized. */
function gridFit(midi, sources) {
  const tolerance = Math.max(1, midi.division / 48), misses = {8: 0, 16: 0, 32: 0}, triplet = {8: 0, 16: 0, 32: 0};
  let total = 0;
  for (const source of sources) {
    for (const n of source.notes) {
      total++;
      const counter = offGrid(n.start, midi.division / 3) <= tolerance ? triplet : misses;
      for (const grid of [8, 16, 32]) if (offGrid(n.start, midi.division * 4 / grid) > tolerance) counter[grid]++;
    }
  }
  return {total, misses, triplet};
}

/* The coarsest grid that holds the note onsets about as well as the finest one does. A few stray
 * notes are tolerated; a performance played without a click fits no grid and gets sixteenths. */
function chooseGrid(midi, fit, triplets) {
  const usable = [8, 16, 32].filter(grid => midi.meters.every(m => Number.isInteger(m.numerator * grid / m.denominator)));
  if (!usable.includes(16)) return 32; // (a meter too fine even for this grid is reported by measureMap)
  const missed = grid => fit.misses[grid] + (triplets ? 0 : fit.triplet[grid]);
  if (missed(32) > fit.total * 0.05) return 16;
  return usable.find(grid => missed(grid) - missed(32) <= fit.total * 0.005);
}

function buildScore(midi, options = {}) {
  const chosen = options.parts ? new Set(options.parts) : null;
  const sources = midi.parts.filter(part => !chosen || chosen.has(part.id));
  if (!sources.length) fail('no-parts');
  const autoGrid = options.grid === 'auto';
  const fit = gridFit(midi, sources);
  const grid = autoGrid ? chooseGrid(midi, fit, options.triplets !== false) : Number(options.grid || 16);
  if (![8, 16, 32].includes(grid)) fail('bad-grid');
  // U time units per quarter note. Divisible by the binary grid step (3 units) and by eighth triplets (U / 3).
  const U = 3 * grid / 4, TRI = U / 3, perTick = U / midi.division;
  let key = midi.key;
  if (options.key != null && options.key !== 'auto') {
    const fifths = Number(options.key);
    if (!Number.isInteger(fifths) || Math.abs(fifths) > 7) fail('bad-key');
    key = {fifths, minor: false, source: 'manual'};
  }
  const map = measureMap(midi, grid, U), ctx = {U, grid, candidates: writableSteps(grid)};

  const parts = [], prepared = [];
  let total = 0, staffCount = 0;
  for (const source of sources) {
    const triplet = options.triplets === false ? new Set() : tripletSpans(source.notes, map, perTick, U);
    const stepAt = unit => { const m = map.at(unit); return m.quarterBased && triplet.has(unit - (unit - m.start) % U) ? TRI : 3; };
    const snap = tick => {
      const u = tick * perTick, m = map.at(u);
      if (m.quarterBased) { const span = m.start + Math.floor((u - m.start) / U) * U; if (triplet.has(span)) return span + Math.round((u - span) / TRI) * TRI; }
      return Math.round(u / 3) * 3;
    };
    const notes = cleanOverlaps(source.notes.map(n => {
      const start = snap(n.start);
      let end = snap(n.start + n.duration);
      if (end <= start) end = start + stepAt(start);
      return {pitch: n.pitch, start, end};
    }));
    const sorted = notes.map(n => n.pitch).sort((x, y) => x - y);
    // Step-entered parts sit exactly on the grid and mean what they say; only played parts are tidied.
    const onGrid = tick => (tick * U) % (midi.division * 3) === 0 || (tick * U) % (midi.division * TRI) === 0;
    const exact = source.notes.filter(n => onGrid(n.start) && onGrid(n.start + n.duration)).length / source.notes.length;
    prepared.push({source, notes, median: sorted[sorted.length >> 1], below: sorted.filter(x => x < 60).length / sorted.length,
      tidy: options.simplify === true || (options.simplify !== false && exact < 0.95)});
  }
  for (let i = 0; i < prepared.length; i++) {
    const a = prepared[i], b = prepared[i + 1], source = a.source;
    const hands = b ? handsOfOneKeyboard(a, b) : null;
    let staves, name = source.name, ids = [source.id];
    if (hands) {
      const [upper, lower] = hands;
      staves = [{clef: upper.median < 55 ? 'bass' : 'treble', notes: upper.notes, tidy: upper.tidy}, {clef: lower.median >= 62 ? 'treble' : 'bass', notes: lower.notes, tidy: lower.tidy}];
      let common = 0;
      while (common < name.length && name[common] === b.source.name[common]) common++;
      name = name.slice(0, common).replace(/[\s\-_:·,(]+$/, '');
      if (name.length < 3) name = source.instrument.label;
      ids.push(b.source.id);
      i++;
    } else staves = planStaves(source, a.notes).filter(staff => staff.notes.length).map(staff => ({...staff, tidy: a.tidy}));
    for (const staff of staves) {
      if (source.percussion) drumDurations(staff.notes, map, U);
      else if (staff.tidy) tidyDurations(staff.notes, map, U);
      staff.events = makeVoices(cleanOverlaps(staff.notes), source.percussion);
      for (const n of staff.notes) if (n.end > total) total = n.end;
      delete staff.notes; delete staff.tidy;
    }
    staffCount += staves.length;
    if (staffCount > LIMITS.staves) fail('too-many-staves');
    parts.push({id: source.id, sources: ids, name, channel: source.channel, percussion: source.percussion, instrument: source.instrument, staves});
  }

  // Drum staves go below the pitched parts, as in band scores. (ABCJS also needs a pitched staff
  // first: the key signature of the first staff is the one the other staves start from.)
  parts.sort((x, y) => x.percussion - y.percussion);
  const measures = map.list.slice(0, map.at(Math.max(0, total - 1)).index + 1);
  if (measures.length > LIMITS.measures) fail('too-many-measures');
  const tempos = midi.tempos.map(t => ({unit: t.tick * perTick, bpm: Math.round(t.bpm)}));
  const keys = key.source === 'file' ? midi.keys.map(k => ({unit: k.tick * perTick, key: {fifths: k.fifths, minor: k.minor}})) : [];
  let ti = 0, ki = 0, running = 120, marked = null, current = {fifths: key.fifths, minor: key.minor};
  measures.forEach((m, j) => {
    // The tempo of a measure is the one in force for most of it (a weighted median). Reading the
    // tempo at the bar line instead would print a momentary value: performances with rubato often
    // open with a tempo that lasts a fraction of a beat.
    while (ti < tempos.length && tempos[ti].unit <= m.start) running = tempos[ti++].bpm;
    const spans = [];
    let from = m.start;
    for (; ti < tempos.length && tempos[ti].unit < m.end; ti++) {
      if (tempos[ti].unit > from) spans.push({bpm: running, length: tempos[ti].unit - from});
      from = tempos[ti].unit; running = tempos[ti].bpm;
    }
    spans.push({bpm: running, length: m.end - from});
    spans.sort((x, y) => x.bpm - y.bpm);
    let bpm = running, covered = 0;
    for (const span of spans) { covered += span.length; if (covered * 2 >= m.length) { bpm = span.bpm; break; } }
    while (ki < keys.length && keys[ki].unit <= m.start + U / 2) current = keys[ki++].key;
    const previous = measures[j - 1];
    m.key = current;
    m.keyChange = j > 0 && (previous.key.fifths !== current.fifths || previous.key.minor !== current.minor);
    m.meterChange = j > 0 && (previous.meter.numerator !== m.meter.numerator || previous.meter.denominator !== m.meter.denominator);
    m.tempo = marked === null || Math.abs(bpm - marked) >= Math.max(4, marked * 0.08) ? (marked = bpm) : null;
  });
  // A performance with continuous rubato would print a metronome mark on almost every bar.
  const rubato = measures.filter(m => m.tempo).length > Math.max(6, measures.length / 6);
  if (rubato) measures.forEach((m, j) => { if (j) m.tempo = null; });

  let voiceCount = 0;
  for (const part of parts) {
    for (const staff of part.staves) {
      staff.voices = staff.events.map(events => ({measures: layoutVoice(events, measures, ctx, part.percussion)}));
      voiceCount += staff.voices.length;
      delete staff.events;
    }
  }
  return {
    grid, autoGrid, unitsPerQuarter: U, measures, parts, staffCount, voiceCount,
    meter: measures[0].meter, tempo: measures[0].tempo, key: {...measures[0].key, source: key.source},
    warnings: midi.warnings.filter(w => w.code !== 'percussion-mapped' || parts.some(part => part.percussion))
      .concat(rubato ? [{code: 'tempo-varies', message: MESSAGES['tempo-varies']}] : [])
      // Notes that sit between even the finest grid positions were played live, not entered on a beat.
      .concat(fit.misses[32] > fit.total * 0.2 ? [{code: 'free-timing', message: MESSAGES['free-timing']}] : [])
  };
}

/* ---------- ABC export (engraved by ABCJS) ---------- */

function abcPitch(p) {
  const accidental = p.alter > 0 ? '^'.repeat(p.alter) : p.alter < 0 ? '_'.repeat(-p.alter) : '=';
  const name = p.octave >= 5 ? p.step.toLowerCase() + "'".repeat(p.octave - 5) : p.step + ','.repeat(4 - p.octave);
  return {accidental, name};
}

/* ABCJS pairs the ties of chord notes in two ways only. A tie written after a whole chord reaches
 * every note of the next chord; a tie written on one chord note reaches the note at the same
 * position in the next chord. This plans the order of the notes in each chord (which does not
 * change the engraving) so that every tie lands on its own pitch. Returns a plan per item. */
function planTies(voice) {
  const flat = voice.measures.flat(), plans = new Map(), life = new Map();
  for (let k = flat.length - 1; k >= 0; k--) { // how many items each tied note still lasts
    if (!flat[k].notes) continue;
    const later = life.get(flat[k + 1]) || new Map(), mine = new Map();
    for (const n of flat[k].notes) mine.set(n.pitch, n.tieOut ? 1 + (later.get(n.pitch) || 0) : 0);
    life.set(flat[k], mine);
  }
  let incoming = null; // how this item's tied-in notes are reached: {index: Map(pitch -> position)} or {whole: true}
  flat.forEach((item, k) => {
    if (!item.notes) { incoming = null; return; }
    const lasting = life.get(item), longestFirst = (x, y) => lasting.get(y.pitch) - lasting.get(x.pitch) || x.pitch - y.pitch;
    let order;
    if (incoming && incoming.index) {
      order = [];
      const free = item.notes.filter(n => !incoming.index.has(n.pitch)).sort(longestFirst);
      for (const n of item.notes) if (incoming.index.has(n.pitch)) order[incoming.index.get(n.pitch)] = n;
      for (let i = 0; free.length; i++) if (!order[i]) order[i] = free.shift();
    } else order = [...item.notes].sort((x, y) => (incoming ? y.tieIn - x.tieIn : 0) || longestFirst(x, y));
    const outs = item.notes.filter(n => n.tieOut), next = flat[k + 1], tied = new Set();
    let whole = false, following = null;
    if (outs.length && next && next.notes) {
      const newcomers = next.notes.some(n => !n.tieIn), continuing = next.notes.some(n => n.tieOut);
      if (outs.length === item.notes.length && !(newcomers && continuing)) { whole = true; following = {whole: true}; }
      else {
        following = {index: new Map()};
        // A position beyond the size of the next chord cannot be reached: that tie is left out.
        order.forEach((n, i) => { if (n.tieOut && i < next.notes.length) { following.index.set(n.pitch, i); tied.add(n.pitch); } });
      }
    }
    plans.set(item, {order, whole, tied, chord: order.length > 1 || tied.size > 0 || !!(incoming && incoming.index)});
    incoming = following;
  });
  return plans;
}

function toABC(score, title = 'Untitled') {
  const {grid, measures, unitsPerQuarter: U} = score;
  const clean = s => String(s).replace(/["\\\r\n%]/g, ' ').trim();
  let id = 0;
  const voices = [], groups = [];
  for (const part of score.parts) {
    const staves = part.staves.map((staff, si) => {
      const ids = staff.voices.map((voice, vi) => {
        voices.push({id: ++id, voice, staff, part, primary: vi === 0, stem: staff.voices.length > 1 ? (vi ? 'down' : 'up') : '', label: si === 0 && vi === 0 ? clean(part.name) : '',
          key: part.percussion ? 'C' : keyName(measures[0].key)});
        return id;
      });
      return ids.length > 1 ? `(${ids.join(' ')})` : String(ids[0]);
    });
    groups.push(staves.length > 1 ? `{${staves.join(' ')}}` : staves[0]);
  }
  // Fewer measures per system when the music is dense.
  const density = Math.max(...voices.map(v => v.voice.measures.reduce((sum, bar) => sum + bar.length, 0) / measures.length));
  const perLine = density <= 12 ? 4 : density <= 18 ? 3 : density <= 32 ? 2 : 1;

  let out = `X:1\nT:${clean(title) || 'Untitled'}\nM:${measures[0].meter.numerator}/${measures[0].meter.denominator}\nL:1/${grid}\nQ:1/4=${measures[0].tempo}\n%%staffsep 65\n%%score ${groups.join(' ')}\n`;
  for (const v of voices) out += `V:${v.id} clef=${v.staff.clef}${v.label ? ` name="${v.label}"` : ''}${v.stem ? ` stem=${v.stem}` : ''}\n`;
  // The header key is that of the first staff. A drum staff has no key signature and says so itself.
  out += `K:${voices[0].key}\n`;

  // ABCJS turns every whole-note rest into a rest as long as one measure of the header meter. That is
  // the wanted whole-measure rest only for an empty measure of exactly that length; any other
  // whole-note rest would get the wrong length, so it is written as two half rests.
  const headerSteps = measures[0].length / 3, writable = new Set(writableSteps(grid));
  const wholeRest = m => m.length === measures[0].length && (headerSteps === grid || writable.has(headerSteps));
  // Rests of the extra voices on a staff are not drawn.
  const rest = (steps, visible) => visible && steps === grid && headerSteps < grid ? `z${grid / 2} z${grid / 2}` : (visible ? 'z' : 'x') + (steps === 1 ? '' : steps);

  voices.forEach((v, index) => {
    const percussion = v.part.percussion, shift = v.staff.clef.endsWith('-8') ? 12 : 0, plans = percussion ? null : planTies(v.voice);
    const held = new Map(); // a note tied over a key change keeps the spelling it started with
    out += `[V:${v.id}]${v.key === voices[0].key ? '' : ` [K:${v.key}${percussion ? ' clef=perc' : ''}]`}\n`;
    v.voice.measures.forEach((bar, j) => {
      const m = measures[j];
      if (m.meterChange) out += `[M:${m.meter.numerator}/${m.meter.denominator}]`;
      if (m.keyChange && !percussion) out += `[K:${keyName(m.key)}]`;
      if (j && m.tempo && index === 0) out += `[Q:1/4=${m.tempo}]`;
      const signature = {}, order = m.key.fifths < 0 ? 'BEADGCF' : 'FCGDAEB';
      for (let i = 0; i < Math.abs(m.key.fifths); i++) signature[order[i]] = m.key.fifths < 0 ? -1 : 1;
      const state = {};
      const pitch = n => {
        if (percussion) { const d = drumDisplay(n.pitch); return (d.head === 'x' ? '!style=x!' : '') + abcPitch({step: d.step, alter: 0, octave: d.octave}).name; }
        const p = (n.tieIn && held.get(n.pitch)) || spell(n.pitch + shift, m.key), slot = p.step + p.octave, a = abcPitch(p);
        if (n.tieOut) held.set(n.pitch, p); else held.delete(n.pitch);
        const previous = state[slot] === undefined ? signature[p.step] || 0 : state[slot];
        state[slot] = p.alter;
        return (previous === p.alter ? '' : a.accidental) + a.name;
      };
      const beam = m.compound ? m.beat : U;
      let position = 0, text = '', previous = null;
      for (const item of bar) {
        const length = item.steps === 1 ? '' : String(item.steps);
        let token;
        // (A rest inside a triplet is always drawn: the bracket needs it.)
        if (item.measureRest) token = v.primary && wholeRest(m) ? `z${grid}` : item.pieces.map(k => rest(k, v.primary)).join(' ');
        else if (item.rest) token = rest(item.steps, v.primary || item.tuplet !== undefined);
        else if (percussion) {
          const used = new Set(), notes = item.notes.filter(n => { const d = drumDisplay(n.pitch), k = d.step + d.octave; return !used.has(k) && used.add(k); });
          token = notes.length === 1 ? pitch(notes[0]) + length : '[' + notes.map(pitch).join('') + ']' + length;
        } else {
          const plan = plans.get(item), text = plan.order.map(n => pitch(n) + (plan.tied.has(n.pitch) ? '-' : '')).join('');
          token = (plan.chord ? `[${text}]` : text) + length + (plan.whole ? '-' : '');
        }
        if (item.tupletStart) token = `(3:2:${item.tupletStart}` + token;
        // Notes written without a space are beamed together: do that only inside one beat.
        const short = !item.rest && item.type !== 'quarter' && item.steps < grid / 4;
        const joined = previous && short && previous.short && Math.floor(previous.position / beam) === Math.floor(position / beam) && !item.tupletStart;
        text += (text && !joined ? ' ' : '') + token;
        previous = {short, position};
        position += item.units;
      }
      out += text + (j === measures.length - 1 ? ' |]' : ' | ');
      if ((j + 1) % perLine === 0 || j === measures.length - 1) out += '\n';
    });
  });
  return out;
}

/* ---------- MusicXML 4.0 export ---------- */

const xml = s => String(s).replace(/[<>&"']/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'}[c]))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const CLEFS = {
  treble: '<sign>G</sign><line>2</line>', bass: '<sign>F</sign><line>4</line>', alto: '<sign>C</sign><line>3</line>',
  'treble-8': '<sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change>',
  'bass-8': '<sign>F</sign><line>4</line><clef-octave-change>-1</clef-octave-change>',
  perc: '<sign>percussion</sign>'
};

function toMusicXML(score, title = 'Untitled') {
  const {measures} = score;
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n' +
    `<score-partwise version="4.0"><work><work-title>${xml(title)}</work-title></work>` +
    '<identification><encoding><software>Staves</software></encoding></identification><part-list>';
  score.parts.forEach((part, i) => {
    const pid = `P${i + 1}`;
    out += `<score-part id="${pid}"><part-name>${xml(part.name)}</part-name>`;
    if (part.percussion) {
      const used = new Set();
      for (const staff of part.staves) for (const voice of staff.voices) for (const bar of voice.measures) for (const item of bar) if (item.notes) for (const n of item.notes) used.add(n.pitch);
      const drums = [...used].sort((x, y) => x - y);
      for (const d of drums) out += `<score-instrument id="${pid}-I${d}"><instrument-name>${xml(drumName(d))}</instrument-name></score-instrument>`;
      for (const d of drums) out += `<midi-instrument id="${pid}-I${d}"><midi-channel>10</midi-channel><midi-program>1</midi-program><midi-unpitched>${d + 1}</midi-unpitched></midi-instrument>`;
    } else {
      out += `<score-instrument id="${pid}-I1"><instrument-name>${xml(part.instrument.name)}</instrument-name></score-instrument>` +
        `<midi-instrument id="${pid}-I1"><midi-channel>${part.channel + 1}</midi-channel><midi-program>${part.instrument.program + 1}</midi-program></midi-instrument>`;
    }
    out += '</score-part>';
  });
  out += '</part-list>';

  score.parts.forEach((part, i) => {
    const pid = `P${i + 1}`, multi = part.staves.length > 1, spellings = new Map();
    out += `<part id="${pid}">`;
    measures.forEach((m, j) => {
      out += `<measure number="${j + 1}">`;
      const keyXML = `<key><fifths>${part.percussion ? 0 : m.key.fifths}</fifths>${part.percussion ? '' : `<mode>${m.key.minor ? 'minor' : 'major'}</mode>`}</key>`;
      const timeXML = `<time><beats>${m.meter.numerator}</beats><beat-type>${m.meter.denominator}</beat-type></time>`;
      if (!j) {
        out += `<attributes><divisions>${score.unitsPerQuarter}</divisions>${keyXML}${timeXML}${multi ? `<staves>${part.staves.length}</staves>` : ''}` +
          part.staves.map((staff, s) => `<clef${multi ? ` number="${s + 1}"` : ''}>${CLEFS[staff.clef]}</clef>`).join('') + '</attributes>';
      } else if (m.meterChange || (m.keyChange && !part.percussion)) {
        out += `<attributes>${m.keyChange && !part.percussion ? keyXML : ''}${m.meterChange ? timeXML : ''}</attributes>`;
      }
      if (m.tempo && i === 0) {
        out += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${m.tempo}</per-minute></metronome></direction-type>` +
          `${multi ? '<staff>1</staff>' : ''}<sound tempo="${m.tempo}"/></direction>`;
      }
      let number = 0, written = false;
      part.staves.forEach((staff, s) => {
        staff.voices.forEach((voice, vi) => {
          number++;
          const bar = voice.measures[j], held = spellings.get(voice) || spellings.set(voice, new Map()).get(voice);
          if (vi > 0 && bar.every(item => item.rest)) return; // an idle second voice needs no rests
          if (written) out += `<backup><duration>${m.length}</duration></backup>`;
          written = true;
          const tail = `<voice>${number}</voice>`, staffXML = multi ? `<staff>${s + 1}</staff>` : '';
          for (const item of bar) {
            const value = item.measureRest ? '' : `<type>${item.type}</type>${item.dots ? '<dot/>' : ''}` +
              (item.tuplet !== undefined ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : '');
            const tuplet = (item.tupletStart ? '<tuplet type="start" bracket="yes"/>' : '') + (item.tupletStop ? '<tuplet type="stop"/>' : '');
            if (item.rest) {
              out += `<note${vi && item.tuplet === undefined ? ' print-object="no"' : ''}><rest${item.measureRest ? ' measure="yes"' : ''}/><duration>${item.units}</duration>${tail}${value}${staffXML}${tuplet ? `<notations>${tuplet}</notations>` : ''}</note>`;
              continue;
            }
            item.notes.forEach((n, k) => {
              let pitchXML, extra = '', head = '';
              if (part.percussion) {
                const d = drumDisplay(n.pitch);
                pitchXML = `<unpitched><display-step>${d.step}</display-step><display-octave>${d.octave}</display-octave></unpitched>`;
                extra = `<instrument id="${pid}-I${n.pitch}"/>`;
                if (d.head === 'x') head = '<notehead>x</notehead>';
              } else {
                const p = (n.tieIn && held.get(n.pitch)) || spell(n.pitch, m.key); // as in toABC
                if (n.tieOut) held.set(n.pitch, p); else held.delete(n.pitch);
                pitchXML = `<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch>`;
              }
              const marks = (n.tieIn ? '<tied type="stop"/>' : '') + (n.tieOut ? '<tied type="start"/>' : '') + (k ? '' : tuplet);
              out += `<note>${k ? '<chord/>' : ''}${pitchXML}<duration>${item.units}</duration>` +
                `${n.tieIn ? '<tie type="stop"/>' : ''}${n.tieOut ? '<tie type="start"/>' : ''}${extra}${tail}${value}${head}${staffXML}` +
                `${marks ? `<notations>${marks}</notations>` : ''}</note>`;
            });
          }
        });
      });
      out += '</measure>';
    });
    out += '</part>';
  });
  return out + '</score-partwise>';
}

const api = {parseMIDI, buildScore, toABC, toMusicXML, instrumentName, instrumentFamily, keyName, StavesError, LIMITS};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
root.Staves = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
