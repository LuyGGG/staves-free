/* Engine tests. Run with: node --test Tests/engine.test.js
 * Rebuild the sample MIDI with: node Tests/engine.test.js --fixture */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {parseMIDI, buildScore, toABC, toMusicXML, instrumentName, keyName} = require('../Staves/Resources/engine.js');
const ABCJS = require('../Staves/Resources/abcjs-basic-min.js');

/* ---------- Helpers that write Standard MIDI files ---------- */

const vlq = n => { const b = [n & 127]; while (n >>= 7) b.unshift((n & 127) | 128); return b; };
const chunk = (id, data) => [...Buffer.from(id), data.length >>> 24, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255, ...data];
const END = [0, 255, 47, 0];
function smf(tracks, {division = 480, format = tracks.length > 1 ? 1 : 0, declared = tracks.length} = {}) {
  return Uint8Array.from([...chunk('MThd', [0, format, 0, declared, division >> 8, division & 255]), ...tracks.flatMap(t => chunk('MTrk', [...t, ...END]))]);
}
const meta = (type, data, delta = 0) => [...vlq(delta), 255, type, ...vlq(data.length), ...data];
const trackName = text => meta(3, [...Buffer.from(text)]);
const tempo = (bpm, delta = 0) => { const us = Math.round(6e7 / bpm); return meta(0x51, [us >> 16, (us >> 8) & 255, us & 255], delta); };
const meter = (n, d, delta = 0) => meta(0x58, [n, Math.log2(d), 24, 8], delta);
const keySignature = (fifths, minor = 0, delta = 0) => meta(0x59, [fifths & 255, minor], delta);
const program = (number, channel = 0, delta = 0) => [...vlq(delta), 0xC0 | channel, number];
/* Consecutive notes: each starts when the previous one ends. */
const note = (pitch, duration = 480, channel = 0) => [0, 0x90 | channel, pitch, 90, ...vlq(duration), 0x80 | channel, pitch, 0];
const melody = (pitches, duration = 480, channel = 0) => pitches.flatMap(p => note(p, duration, channel));
/* Notes at absolute ticks, so they can overlap: [pitch, start, duration]. Extra timed events as [tick, bytes]. */
function timed(notes, {channel = 0, extra = []} = {}) {
  const events = extra.map(([tick, bytes]) => ({tick, order: 0, bytes}));
  for (const [pitch, start, duration] of notes) {
    events.push({tick: start + duration, order: 1, bytes: [0x80 | channel, pitch, 0]});
    events.push({tick: start, order: 2, bytes: [0x90 | channel, pitch, 90]});
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let now = 0;
  return events.flatMap(e => { const out = [...vlq(e.tick - now), ...e.bytes]; now = e.tick; return out; });
}

function demo() {
  return smf([
    [...trackName('Flute'), ...meter(4, 4), ...tempo(120), ...program(73), ...melody([72, 74, 76, 77, 79, 76, 74, 72, 76, 77, 79, 81, 79, 76, 74, 72])],
    [...trackName('Piano'), ...program(0, 1), ...melody([48, 43, 48, 43], 1920, 1)]
  ]);
}
if (process.argv.includes('--fixture')) { fs.writeFileSync(path.join(__dirname, 'First-light.mid'), demo()); process.exit(0); }

/* ---------- Helpers that inspect a score ---------- */

const voices = score => score.parts.flatMap(p => p.staves.flatMap(s => s.voices));
const items = voice => voice.measures.flat();
const pitched = voice => items(voice).filter(i => i.notes);
/* Every measure of every voice is exactly full, and ABCJS accepts the ABC without warnings. */
function sound(score) {
  for (const voice of voices(score)) {
    assert.equal(voice.measures.length, score.measures.length);
    voice.measures.forEach((bar, j) => assert.equal(bar.reduce((sum, i) => sum + i.units, 0), score.measures[j].length, `measure ${j + 1} is not full`));
  }
  const abc = toABC(score, 'Test'), tune = ABCJS.parseOnly(abc)[0];
  assert.deepEqual(tune.warnings || [], []);
  tiesArePaired(tune);
  const xml = toMusicXML(score, 'Test'), open = [];
  for (const [, close, tag, , selfClosing] of xml.replace(/<\?xml.*?\?>|<!DOCTYPE[^>]*>/g, '').matchAll(/<(\/?)([\w-]+)([^<>]*?)(\/?)>/g)) {
    if (close) assert.equal(open.pop(), tag); else if (!selfClosing) open.push(tag);
  }
  assert.deepEqual(open, []);
  return {abc, xml};
}
/* Replays how ABCJS draws ties: a tie must end on the same pitch in the very next note or chord. */
function tiesArePaired(tune) {
  const byVoice = new Map();
  tune.lines.forEach(line => (line.staff || []).forEach((staff, s) => staff.voices.forEach((voice, v) => {
    const id = s + ':' + v;
    if (!byVoice.has(id)) byVoice.set(id, []);
    byVoice.get(id).push(...voice.filter(e => e.el_type === 'note'));
  })));
  for (const elements of byVoice.values()) {
    let open = [];
    for (const element of elements) {
      const before = open.length;
      for (const p of element.pitches || []) {
        if (p.endTie && open.length) {
          const match = open.findIndex(tie => tie.pitch === p.pitch);
          assert.ok(match >= 0, 'a tie would be drawn to a different pitch');
          open.splice(match, 1);
        }
        if (p.startTie) open.push({pitch: p.pitch, fresh: true});
      }
      assert.ok(open.every(tie => tie.fresh), `${before} tie(s) were not closed by the next chord`);
      open = open.map(tie => ({pitch: tie.pitch}));
    }
    assert.equal(open.length, 0);
  }
}
/* Where every written note starts, as "position:pitch". A tied continuation is not a new note. */
function writtenOnsets(score) {
  const out = new Set();
  for (const voice of voices(score)) {
    let position = 0;
    for (const item of items(voice)) {
      for (const n of item.notes || []) if (!n.tieIn) out.add(position + ':' + n.pitch);
      position += item.units;
    }
  }
  return [...out].sort();
}
const body = (abc, voice = 1) => abc.split(`[V:${voice}]`)[1].split('[V:')[0].replace(/\s+/g, ' ').trim();

/* ---------- Parsing ---------- */

test('format 1 file: parts, meter, tempo and four full measures', () => {
  const midi = parseMIDI(demo());
  assert.equal(midi.format, 1);
  assert.deepEqual(midi.parts.map(p => [p.id, p.name, p.notes.length]), [['0-0', 'Flute', 16], ['1-1', 'Piano', 4]]);
  assert.deepEqual(midi.meter, {numerator: 4, denominator: 4});
  assert.equal(midi.tempo, 120);
  const score = buildScore(midi);
  assert.equal(score.measures.length, 4);
  assert.equal(score.staffCount, 2);
  assert.deepEqual(score.parts.map(p => p.staves[0].clef), ['treble', 'bass']);
  assert.match(sound(score).abc, /K:C\n/);
});

test('the bundled sample files match the generator', () => {
  for (const file of ['First-light.mid', '../web/assets/First-light.mid']) assert.deepEqual([...fs.readFileSync(path.join(__dirname, file))], [...demo()]);
});

test('running status and velocity-zero note off', () => {
  const midi = parseMIDI(smf([[0, 144, 60, 100, 0, 64, 90, ...vlq(480), 60, 0, 0, 64, 0]]));
  assert.equal(midi.parts[0].notes.length, 2);
  assert.equal(midi.parts[0].notes[1].duration, 480);
});

test('running status survives a meta event, as real files require', () => {
  const midi = parseMIDI(smf([[0, 144, 60, 100, ...meta(1, [65]), ...vlq(480), 60, 0]]));
  assert.equal(midi.parts[0].notes[0].duration, 480);
});

test('instrument comes from Program Change, in English and Chinese', () => {
  const midi = parseMIDI(smf([[...program(40), ...note(67)], [...trackName('Solo'), ...program(56, 1), ...note(67, 480, 1)]]));
  assert.deepEqual(midi.parts.map(p => [p.name, p.instrument.program, p.instrument.name, p.instrument.family, p.instrument.source]),
    [['Violin', 40, 'Violin', 'Strings', 'program'], ['Solo', 56, 'Trumpet', 'Brass', 'program']]);
  assert.equal(parseMIDI(smf([[...program(40), ...note(67)]]), {lang: 'zh'}).parts[0].name, '小提琴');
  assert.equal(instrumentName(73, 'zh'), '长笛');
  assert.equal(instrumentName(127), 'Gunshot');
});

test('channel 10 is percussion whatever its program', () => {
  const midi = parseMIDI(smf([[...program(5, 9), ...note(36, 240, 9), ...note(38, 240, 9)]]));
  assert.equal(midi.parts[0].percussion, true);
  assert.equal(midi.parts[0].instrument.source, 'percussion');
  assert.equal(midi.parts[0].name, 'Percussion');
  assert.ok(midi.warnings.some(w => w.code === 'percussion-mapped'));
});

test('without a Program Change the track name decides, then the piano default', () => {
  const midi = parseMIDI(smf([[...trackName('Cello section'), ...note(48)], [...trackName('低音提琴'), ...note(36, 480, 1)], [...trackName('Lead'), ...note(72, 480, 2)]]));
  assert.deepEqual(midi.parts.map(p => [p.instrument.name, p.instrument.source]), [['Cello', 'name'], ['Contrabass', 'name'], ['Acoustic Grand Piano', 'default']]);
});

test('a format 0 file yields one named part per channel', () => {
  const midi = parseMIDI(smf([[...trackName('Song'), ...program(73, 0), ...program(42, 1), ...timed([[72, 0, 480]]), ...timed([[48, 0, 480]], {channel: 1})]]));
  assert.deepEqual(midi.parts.map(p => p.name), ['Flute', 'Cello']);
});

test('a part keeps the sound most of its notes use (arco with a little pizzicato)', () => {
  const midi = parseMIDI(smf([[...trackName('Violins'), ...program(48), ...melody([67, 69, 71]), ...program(45), ...note(72), ...program(48), ...note(74)]]));
  assert.equal(midi.parts.length, 1);
  assert.equal(midi.parts[0].name, 'Violins');
  assert.equal(midi.parts[0].instrument.name, 'String Ensemble 1');
});

test('a track that plays on several channels keeps its name on the main one', () => {
  const viola = [...trackName('Viola'), ...program(41, 7), ...program(45, 8), ...melody([60, 62, 64], 480, 7), ...note(67, 480, 8)];
  assert.deepEqual(parseMIDI(smf([[...tempo(120)], viola])).parts.map(p => p.name), ['Viola', 'Viola · Pizzicato Strings']);
  assert.deepEqual(parseMIDI(smf([[...tempo(120)], viola]), {lang: 'zh'}).parts.map(p => p.name), ['Viola', 'Viola · 弦乐拨奏']);
});

test('programs do not leak between tracks that reuse a channel on another port', () => {
  const port = n => meta(0x21, [n]);
  const midi = parseMIDI(smf([[...port(0), ...trackName('Flute'), ...program(73), ...note(72)], [...port(1), ...trackName('Tutti'), ...program(44), ...note(60)], [...port(1), ...trackName('Oboe 2'), ...note(64)]]));
  assert.deepEqual(midi.parts.map(p => [p.instrument.name, p.instrument.source]), [['Flute', 'program'], ['Tremolo Strings', 'program'], ['Oboe', 'name']]);
});

test('a setup track can carry the program for another track on a single port', () => {
  const midi = parseMIDI(smf([[...program(71, 2)], [...trackName('Melody'), ...note(67, 480, 2)]]));
  assert.deepEqual([midi.parts[0].instrument.name, midi.parts[0].instrument.source], ['Clarinet', 'program']);
});

test('unknown chunks are skipped and RIFF-wrapped files are read', () => {
  const plain = smf([[...note(60)]]);
  const withChunk = Uint8Array.from([...plain.slice(0, 14), ...chunk('XFIH', [1, 2, 3]), ...plain.slice(14)]);
  assert.equal(parseMIDI(withChunk).parts[0].notes.length, 1);
  const riff = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('RMIDdata'), 0, 0, 0, 0, ...plain]);
  assert.equal(parseMIDI(riff).parts[0].notes.length, 1);
});

test('track names are decoded as UTF-8, GBK or Latin-1', () => {
  const named = bytes => parseMIDI(smf([[...meta(3, bytes), ...program(0), ...note(60)]])).parts[0].name;
  assert.equal(named([...Buffer.from('钢琴独奏')]), '钢琴独奏');
  assert.equal(named([0xB8, 0xD6, 0xC7, 0xD9]), '钢琴'); // GBK
  assert.equal(named([0x46, 0x6C, 0xF6, 0x74, 0x65]), 'Flöte'); // Latin-1
});

test('damaged files: readable parts are kept, hopeless files fail clearly', () => {
  const cut = parseMIDI(demo().slice(0, -2));
  assert.equal(cut.parts.length, 2);
  assert.ok(cut.warnings.some(w => w.code === 'truncated'));
  assert.ok(parseMIDI(smf([[...note(60)]], {declared: 3})).warnings.some(w => w.code === 'truncated'));
  const corrupt = parseMIDI(smf([[...note(60), 0, 0xF4, 0, ...note(62)]]));
  assert.equal(corrupt.parts[0].notes.length, 1);
  assert.ok(corrupt.warnings.some(w => w.code === 'corrupt-track'));
  const code = bytes => { try { parseMIDI(bytes); } catch (e) { return e.code; } return 'ok'; };
  assert.equal(code(new Uint8Array([1, 2, 3])), 'not-midi');
  assert.equal(code(Buffer.from('not a midi file at all')), 'not-midi');
  assert.equal(code(smf([[...note(60)]], {division: 0xE728})), 'smpte');
  assert.equal(code(smf([[...note(60)]], {format: 2})), 'format-2');
  assert.equal(code(smf([[0, 60, 90]])), 'invalid-event');
  assert.equal(code(smf([[...trackName('Empty')]])), 'no-notes');
});

test('unclosed notes end at the track boundary; warnings carry codes and text', () => {
  const midi = parseMIDI(smf([[0, 144, 60, 90, ...vlq(480), 176, 64, 127, 0, 224, 0, 80]]));
  assert.equal(midi.parts[0].notes[0].duration, 480);
  assert.deepEqual(midi.warnings.map(w => w.code).sort(), ['pitch-bend', 'sustain-pedal', 'unclosed-notes']);
  assert.ok(midi.warnings.every(w => typeof w.message === 'string' && w.message.length > 10));
  // A centred pitch wheel is only a reset.
  assert.deepEqual(parseMIDI(smf([[0, 224, 0, 64, ...note(60)]])).warnings, []);
});

/* ---------- Rhythm ---------- */

test('notes crossing a bar line are tied and every measure is full', () => {
  const score = buildScore(parseMIDI(smf([[...note(60, 2400)]])));
  assert.equal(score.measures.length, 2);
  const [first, second] = voices(score)[0].measures;
  assert.equal(first[0].notes[0].tieOut, true);
  assert.equal(second[0].notes[0].tieIn, true);
  assert.equal(second[0].notes[0].tieOut, false);
  const {abc, xml} = sound(score);
  assert.match(body(abc), /^C16- \| C4 z4 z8 \|\]$/);
  assert.match(xml, /<tie type="stop"\/>/);
});

test('durations are split at the beat, with dots and syncopation where usual', () => {
  const write = notes => body(sound(buildScore(parseMIDI(smf([[...timed(notes)]])))).abc);
  assert.equal(write([[60, 0, 600]]), 'C4- C z z2 z8 |]'); // five sixteenths: quarter tied to a sixteenth
  assert.equal(write([[60, 0, 720]]), 'C6 z2 z8 |]'); // dotted quarter
  assert.equal(write([[60, 240, 480], [62, 720, 240]]), 'z2 C4 D2 z8 |]'); // eighth-quarter-eighth syncopation
  assert.equal(write([[60, 360, 480]]), 'z2 z C- C3 z z8 |]'); // an off-beat sixteenth start shows the beat
  assert.equal(write([[60, 720, 480]]), 'z4 z2 C2- C2 z2 z4 |]'); // never hides the middle of a 4/4 bar
});

test('short notes are beamed within a beat, not across beats', () => {
  const abc = sound(buildScore(parseMIDI(smf([[...melody([60, 62, 64, 65, 67, 69, 71, 72], 240)]])))).abc;
  assert.equal(body(abc), 'C2D2 E2F2 G2A2 B2c2 |]');
});

test('compound meters group by the dotted beat', () => {
  const score = buildScore(parseMIDI(smf([[...meter(6, 8), ...timed([[60, 0, 480], [62, 480, 240], [64, 720, 960]])]])));
  assert.equal(score.measures[0].length, 36);
  assert.equal(body(sound(score).abc), 'C4 D2 E6- | E2 z2 z2 z6 |]');
});

test('quantization grid and part selection', () => {
  const midi = parseMIDI(demo());
  const score = buildScore(midi, {grid: 8, parts: [midi.parts[1].id]});
  assert.equal(score.staffCount, 1);
  assert.equal(score.measures[0].length, 24);
  sound(score);
  const fine = buildScore(parseMIDI(smf([[...melody([60, 62, 64, 65], 60)]])), {grid: 32});
  assert.equal(body(sound(fine).abc), 'CDEF z4 z8 z16 |]');
  assert.throws(() => buildScore(midi, {parts: []}), {code: 'no-parts'});
  assert.throws(() => buildScore(midi, {grid: 12}), {code: 'bad-grid'});
  assert.throws(() => buildScore(parseMIDI(smf([[...meter(5, 16), ...note(60)]])), {grid: 8}), {code: 'meter-too-fine'});
});

test('automatic rhythm precision is the coarsest grid that holds the notes', () => {
  const auto = (track, options = {}) => buildScore(parseMIDI(smf([track])), {grid: 'auto', ...options});
  assert.deepEqual([240, 120, 60].map(length => auto(melody([60, 62, 64, 65], length)).grid), [8, 16, 32]);
  assert.equal(auto(melody([60, 62, 64, 65], 120)).autoGrid, true);
  assert.equal(buildScore(parseMIDI(smf([melody([60, 62, 64, 65], 120)])), {grid: 16}).autoGrid, false);
  // Eighth triplets fit every grid, as long as they are recognized.
  const triplets = auto(melody([60, 62, 64, 60, 62, 64], 160));
  assert.equal(triplets.grid, 8);
  assert.ok(sound(triplets).abc.includes('(3'));
  assert.equal(auto(melody([60, 62, 64, 60, 62, 64], 160), {triplets: false}).grid, 16);
  // One stray note among hundreds does not make the whole score finer.
  const eighths = Array.from({length: 240}, (_, i) => [60 + i % 12, i * 240, 240]);
  assert.equal(auto(timed([...eighths, [72, 60, 30]])).grid, 8);
  // But a real share of finer notes does.
  assert.equal(auto(timed([...eighths, ...Array.from({length: 8}, (_, i) => [84, 120 + i * 480, 60])])).grid, 16);
  // A performance played without a click fits no grid: sixteenths, and a warning that says why.
  const played = auto(timed(eighths.map(([pitch, start], i) => [pitch, start + (i * 37) % 53, 200])));
  assert.equal(played.grid, 16);
  assert.ok(played.warnings.some(w => w.code === 'free-timing' && w.message));
  assert.ok(!auto(timed(eighths)).warnings.some(w => w.code === 'free-timing'));
  // Triplets are not free timing, even when their recognition is switched off.
  assert.ok(!auto(melody([60, 62, 64, 60, 62, 64], 160), {triplets: false}).warnings.some(w => w.code === 'free-timing'));
  // The meter rules out grids that cannot divide its measures.
  assert.equal(auto([...meter(5, 16), ...melody([60, 62, 64, 65, 67], 240)]).grid, 16);
  assert.equal(auto([...meter(3, 32), ...melody([60, 62, 64], 60)]).grid, 32);
  sound(auto([...meter(3, 32), ...melody([60, 62, 64], 60)]));
});

test('eighth-note triplets are recognized and can be switched off', () => {
  const bytes = smf([[...melody([60, 62, 64], 160), ...note(65, 480), ...timed([[67, 0, 320], [69, 320, 160]])]]);
  const score = buildScore(parseMIDI(bytes));
  const {abc, xml} = sound(score);
  assert.equal(body(abc), '(3:2:3C2D2E2 F4 (3:2:2G4 A2 z4 |]');
  assert.equal((xml.match(/<time-modification>/g) || []).length, 5);
  assert.equal((xml.match(/<tuplet type="start"/g) || []).length, 2);
  assert.equal((xml.match(/<tuplet type="stop"/g) || []).length, 2);
  const plain = buildScore(parseMIDI(bytes), {triplets: false});
  assert.ok(!sound(plain).abc.includes('(3'));
  // Triplets played a little off the beat are still triplets, on every grid.
  const loose = smf([timed([[60, 6, 150], [62, 152, 150], [64, 327, 150], [65, 473, 150], [67, 648, 150], [69, 795, 150], [71, 960, 960]])]);
  for (const grid of [8, 16, 32]) assert.match(body(sound(buildScore(parseMIDI(loose), {grid})).abc), /^\(3:2:3C\d?D\d?E\d? \(3:2:3F\d?G\d?A\d? /);
  // Thirty-second notes written on a thirty-second grid are not.
  assert.ok(!sound(buildScore(parseMIDI(smf([timed([[60, 0, 180], [62, 180, 120], [64, 300, 180], [65, 480, 480]])])), {grid: 32})).abc.includes('(3'));
  // Straight sixteenths and dotted rhythms are never mistaken for triplets.
  assert.ok(!sound(buildScore(parseMIDI(smf([[...melody([60, 62, 64, 65], 120), ...note(67, 360), ...note(69, 120)]])))).abc.includes('(3'));
});

test('time-signature changes start new measures of the right length', () => {
  const score = buildScore(parseMIDI(smf([[...meter(4, 4), ...melody([60, 62, 64, 65]), ...meter(3, 4), ...melody([67, 69, 71]), ...meter(6, 8), ...melody([72], 1440)]])));
  assert.deepEqual(score.measures.map(m => [m.meter.numerator, m.meter.denominator, m.length, m.meterChange]), [[4, 4, 48, false], [3, 4, 36, true], [6, 8, 36, true]]);
  const {abc, xml} = sound(score);
  assert.equal(body(abc), 'C4 D4 E4 F4 | [M:3/4]G4 A4 B4 | [M:6/8]c12 |]');
  assert.equal((xml.match(/<time>/g) || []).length, 3);
});

test('empty measures: a whole-measure rest where ABCJS can draw one, plain rests otherwise', () => {
  const five = buildScore(parseMIDI(smf([[...meter(5, 8), ...timed([[60, 0, 240], [62, 2400, 240]])]])));
  const {abc, xml} = sound(five);
  assert.equal(body(abc), 'C2 z2 z4 z2 | z8 z2 | D2 z2 z4 z2 |]');
  assert.match(xml, /<rest measure="yes"\/><duration>30<\/duration>/);
  // After a change from 3/4 to 4/4 a whole rest would be drawn with the length of a 3/4 bar.
  const mixed = buildScore(parseMIDI(smf([[...meter(3, 4), ...timed([[60, 0, 1440], [62, 3360, 480]], {extra: [[1440, [255, 0x58, 4, 4, 2, 24, 8]]]})]])));
  assert.equal(body(sound(mixed).abc), 'C12 | [M:4/4]z8 z8 | D4 z4 z8 |]');
  assert.equal(body(sound(buildScore(parseMIDI(smf([[...meter(3, 4), ...timed([[60, 0, 480], [62, 2880, 480]])]])))).abc), 'C4 z4 z4 | z16 | D4 z4 z4 |]');
});

test('tempo changes are marked; continuous rubato is not', () => {
  const steady = buildScore(parseMIDI(smf([[...tempo(120), ...melody([60, 62, 64, 65]), ...tempo(90), ...melody([67, 69, 71, 72])]])));
  assert.deepEqual(steady.measures.map(m => m.tempo), [120, 90]);
  assert.match(sound(steady).abc, /\[Q:1\/4=90\]/);
  const rubato = [];
  for (let i = 0; i < 24; i++) rubato.push(...tempo(i % 2 ? 80 : 120), ...melody([60, 62, 64, 65]));
  const free = buildScore(parseMIDI(smf([rubato])));
  assert.equal(free.measures.filter(m => m.tempo).length, 1);
  assert.ok(free.warnings.some(w => w.code === 'tempo-varies'));
});

test('the tempo of a measure is the one that lasts, not a momentary value at the bar line', () => {
  const set = bpm => { const us = Math.round(6e7 / bpm); return [255, 0x51, 3, us >> 16, (us >> 8) & 255, us & 255]; };
  const notes = [60, 62, 64, 65, 67, 69, 71, 72].map((pitch, i) => [pitch, i * 480, 480]);
  // A rubato performance: 100 for an eighth note, 32 for the next, then 66 for the rest of the bar.
  const opening = buildScore(parseMIDI(smf([timed(notes, {extra: [[0, set(100)], [240, set(32)], [480, set(66)]]})])));
  assert.equal(opening.tempo, 66);
  assert.match(sound(opening).abc, /Q:1\/4=66/);
  // A change on the last beat of a bar is marked at the next bar.
  const late = buildScore(parseMIDI(smf([timed(notes, {extra: [[0, set(120)], [1440, set(90)]]})])));
  assert.deepEqual(late.measures.map(m => m.tempo), [120, 90]);
});

test('a far-away stray note cannot create an endless score', () => {
  assert.throws(() => buildScore(parseMIDI(smf([[...note(60), ...vlq(0x0FFFFFFF), 144, 62, 90, ...vlq(480), 128, 62, 0]]))), {code: 'too-many-measures'});
});

/* ---------- Pitch and key ---------- */

test('key signature from the file, with flats and minor keys spelled correctly', () => {
  const score = buildScore(parseMIDI(smf([[...keySignature(-2, 1), ...timed([[61, 0, 480], [65, 0, 480], [66, 480, 480], [70, 960, 480]])]])));
  assert.deepEqual(score.key, {fifths: -2, minor: true, source: 'file'});
  const {abc, xml} = sound(score);
  assert.match(abc, /K:Gm\n/);
  assert.equal(body(abc), '[_DF]4 ^F4 B4 z4 |]'); // D flat (not C sharp), the leading note F sharp, B flat from the signature
  assert.match(xml, /<fifths>-2<\/fifths><mode>minor<\/mode>/);
  assert.match(xml, /<step>B<\/step><alter>-1<\/alter>/);
});

test('the key is estimated when the file has none, or only the C major default', () => {
  const dMajor = [62, 64, 66, 67, 69, 71, 73, 74, 73, 71, 69, 67, 66, 64, 62, 62];
  const estimated = parseMIDI(smf([[...melody(dMajor)]]));
  assert.deepEqual(estimated.key, {fifths: 2, minor: false, source: 'estimated'});
  assert.equal(keyName(estimated.key), 'D');
  assert.ok(!body(sound(buildScore(estimated)).abc).includes('^')); // no accidentals needed
  assert.equal(parseMIDI(smf([[...keySignature(0), ...melody(dMajor)]])).key.source, 'estimated');
  assert.equal(parseMIDI(smf([[...keySignature(-1), ...melody(dMajor)]])).key.source, 'file');
  assert.equal(parseMIDI(smf([[...keySignature(0), ...melody([60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60, 60])]])).key.source, 'file');
  assert.equal(parseMIDI(smf([[...note(61)]])).key.source, 'default'); // too little to judge
});

test('key changes are written where they happen; a manual key overrides both', () => {
  const midi = parseMIDI(smf([[...keySignature(0), ...melody([60, 64, 67, 72]), ...keySignature(3), ...melody([69, 73, 76, 81])]]));
  const score = buildScore(midi);
  assert.deepEqual(score.measures.map(m => [m.key.fifths, m.keyChange]), [[0, false], [3, true]]);
  const {abc, xml} = sound(score);
  assert.equal(body(abc), 'C4 E4 G4 c4 | [K:A]A4 c4 e4 a4 |]');
  assert.equal((xml.match(/<key>/g) || []).length, 2);
  const manual = buildScore(midi, {key: -1});
  assert.deepEqual(manual.measures.map(m => m.key.fifths), [-1, -1]);
  assert.equal(manual.key.source, 'manual');
  sound(manual);
  assert.throws(() => buildScore(midi, {key: 9}), {code: 'bad-key'});
});

test('a note tied across a key change keeps its spelling', () => {
  const midi = parseMIDI(smf([[...keySignature(4), ...timed([[68, 0, 3840]], {extra: [[1920, [255, 0x59, 2, 252, 0]]]})]]));
  const {abc, xml} = sound(buildScore(midi));
  assert.equal(body(abc), 'G16- | [K:Ab]^G16 |]'); // G sharp throughout, never tied to A flat
  assert.equal((xml.match(/<step>G<\/step><alter>1<\/alter>/g) || []).length, 2);
});

test('accidentals are written once per measure and cancelled when needed', () => {
  const abc = sound(buildScore(parseMIDI(smf([[...keySignature(0), ...melody([66, 66, 65, 66, 66])]])))).abc;
  assert.equal(body(abc), '^F4 F4 =F4 ^F4 | ^F4 z4 z8 |]');
});

/* ---------- Staves and voices ---------- */

test('chords stay together; two independent lines share a staff as two voices', () => {
  const score = buildScore(parseMIDI(smf([[...timed([[72, 0, 1920], [60, 0, 480], [64, 0, 480], [62, 480, 480], [64, 960, 960]])]])), {simplify: false});
  assert.equal(score.staffCount, 1);
  assert.equal(score.voiceCount, 2);
  const {abc, xml} = sound(score);
  assert.match(abc, /%%score \(1 2\)\n/);
  assert.match(abc, /V:1 clef=treble name="[^"]+" stem=up\nV:2 clef=treble stem=down/);
  assert.equal(body(abc, 1), 'c16 |]');
  assert.equal(body(abc, 2), '[CE]4 D4 E8 |]');
  assert.match(xml, /<backup><duration>48<\/duration><\/backup>/);
  assert.match(xml, /<voice>2<\/voice>/);
});

test('held notes under a moving line are long notes in their own voices, not tie chains', () => {
  const score = buildScore(parseMIDI(smf([[...timed([[60, 0, 1920], [64, 480, 1440], [67, 960, 960], [72, 1440, 480]])]])));
  assert.equal(score.voiceCount, 4);
  const {abc, xml} = sound(score);
  assert.match(abc, /%%score \(1 2 3 4\)\n/);
  assert.deepEqual([1, 2, 3, 4].map(v => body(abc, v)), ['z8 z4 c4 |]', 'x8 G8 |]', 'x4 E12 |]', 'C16 |]']);
  assert.match(xml, /<note print-object="no"><rest\/>/);
});

test('more than four overlapping lines become chords whose ties ABCJS pairs correctly', () => {
  const rising = [[60, 0, 1920], [64, 240, 1680], [67, 480, 1440], [72, 720, 1200], [76, 960, 960]];
  const score = buildScore(parseMIDI(smf([[...timed(rising)]])));
  assert.equal(score.voiceCount, 1);
  assert.equal(body(sound(score).abc), '[C-]2[C-E-]2 [C-E-G-]2[CEGc]2- [CEGce]8 |]');
  // Notes released from the bottom up, and other tangled shapes, still pair every tie that is written.
  const tangled = [[48, 0, 480], [52, 0, 960], [55, 0, 1440], [60, 0, 1920], [64, 0, 2400], [67, 240, 2400], [72, 720, 240], [76, 1200, 1440], [59, 1680, 960], [62, 1680, 240]];
  for (const grid of [8, 16, 32]) sound(buildScore(parseMIDI(smf([[...timed(tangled)]])), {grid}));
});

test('a second voice that is silent for a whole measure is hidden, not filled with rests', () => {
  const score = buildScore(parseMIDI(smf([[...timed([[72, 0, 1920], [60, 0, 480], [74, 1920, 1920]])]])), {simplify: false});
  const {abc, xml} = sound(score);
  assert.equal(body(abc, 2), 'C4 x4 x8 | x16 |]');
  assert.equal((xml.match(/<backup>/g) || []).length, 1);
});

test('keyboard parts with both hands get a grand staff', () => {
  const score = buildScore(parseMIDI(smf([[...program(0), ...timed([[72, 0, 960], [76, 960, 960], [48, 0, 1920], [36, 0, 1920]])]])));
  assert.deepEqual(score.parts[0].staves.map(s => s.clef), ['treble', 'bass']);
  const {abc, xml} = sound(score);
  assert.match(abc, /%%score \{1 2\}\n/);
  assert.match(xml, /<staves>2<\/staves><clef number="1"><sign>G<\/sign><line>2<\/line><\/clef><clef number="2"><sign>F<\/sign>/);
  assert.match(xml, /<staff>2<\/staff>/);
  assert.equal((xml.match(/<part id=/g) || []).length, 1);
});

test('right-hand and left-hand tracks are joined into one grand staff', () => {
  const midi = parseMIDI(smf([[...trackName('Piano right'), ...program(0), ...melody([72, 74, 76, 77])], [...trackName('Piano left'), ...program(0, 1), ...melody([48, 55], 960, 1)]]));
  const score = buildScore(midi);
  assert.equal(score.parts.length, 1);
  assert.equal(score.parts[0].name, 'Piano');
  assert.deepEqual(score.parts[0].sources, ['0-0', '1-1']);
  assert.match(sound(score).abc, /%%score \{1 2\}\n/);
  assert.equal(buildScore(midi, {parts: ['1-1']}).parts[0].name, 'Piano left'); // alone, it stays itself
});

test('clefs follow the instrument: bass, alto for viola, octave clefs for guitar and bass', () => {
  const clef = (number, pitches) => { const score = buildScore(parseMIDI(smf([[...program(number), ...melody(pitches)]]))); sound(score); return score.parts[0].staves[0].clef; };
  assert.equal(clef(42, [36, 43, 48, 50]), 'bass');
  assert.equal(clef(70, [57, 60, 62, 64]), 'bass'); // a bassoon stays in bass clef around middle C
  assert.equal(clef(71, [57, 60, 62, 64]), 'treble'); // a clarinet does not
  assert.equal(clef(41, [55, 60, 62, 64]), 'alto');
  assert.equal(clef(73, [72, 74, 76, 77]), 'treble');
  assert.equal(clef(33, [28, 33, 35, 40]), 'bass-8');
  assert.equal(clef(24, [40, 45, 50, 52]), 'treble-8');
  const guitar = buildScore(parseMIDI(smf([[...program(24), ...keySignature(0), ...melody([40, 45, 50, 52])]])));
  assert.equal(body(toABC(guitar)), 'E,4 A,4 D4 E4 |]'); // drawn an octave up under the 8 clef
  assert.match(toMusicXML(guitar), /<clef-octave-change>-1<\/clef-octave-change>/);
  assert.match(toMusicXML(guitar), /<step>E<\/step><octave>2<\/octave>/); // MusicXML keeps the sounding pitch
});

test('percussion is written on a drum staff with cross noteheads for cymbals', () => {
  const hats = [0, 240, 480, 720].map(t => [42, t, 60]);
  const score = buildScore(parseMIDI(smf([[...timed([...hats, [36, 0, 60], [38, 480, 60], [36, 960, 60]], {channel: 9})]])));
  assert.equal(score.parts[0].staves[0].clef, 'perc');
  const {abc, xml} = sound(score);
  assert.match(abc, /V:1 clef=perc/);
  assert.equal(body(abc), '[F!style=x!g]2!style=x!g2 [c!style=x!g]2!style=x!g2 F4 z4 |]');
  // Beside a pitched part in a key, the drum staff still has no key signature.
  const band = toABC(buildScore(parseMIDI(smf([[...keySignature(2), ...program(73), ...melody([74, 76, 78, 79])], [...note(36, 240, 9)]]))));
  assert.match(band, /\nK:D\n/);
  assert.match(band, /\[V:2\] \[K:C clef=perc\]\n/);
  assert.match(xml, /<sign>percussion<\/sign>/);
  assert.match(xml, /<unpitched><display-step>G<\/display-step><display-octave>5<\/display-octave><\/unpitched>/);
  assert.match(xml, /<notehead>x<\/notehead>/);
  assert.match(xml, /<instrument-name>Closed Hi-Hat<\/instrument-name>/);
  assert.match(xml, /<midi-unpitched>37<\/midi-unpitched>/); // Bass Drum 1, one-based
  assert.ok(!xml.includes('<tie'));
});

test('performance durations are tidied unless switched off', () => {
  const played = smf([[...timed([[60, 0, 500], [62, 480, 380], [64, 960, 960]])]]); // a legato overlap, then a note released early
  assert.equal(body(sound(buildScore(parseMIDI(played))).abc), 'C4 D4 E8 |]');
  assert.equal(body(sound(buildScore(parseMIDI(played), {simplify: false})).abc), 'C4 D3 z E8 |]');
});

test('repeated and duplicated notes cannot overlap themselves', () => {
  const score = buildScore(parseMIDI(smf([[...timed([[60, 0, 960], [60, 0, 480], [60, 480, 480]])]])), {simplify: false});
  assert.equal(body(sound(score).abc), 'C4 C4 z8 |]');
});

/* ---------- MusicXML ---------- */

test('MusicXML carries instruments, note types and escaped names', () => {
  const midi = parseMIDI(smf([[...trackName('A & B <1>'), ...program(73, 3), ...note(72, 720, 3), ...note(74, 240, 3), ...note(76, 960, 3)]]));
  const xml = sound(buildScore(midi)).xml;
  const titled = toMusicXML(buildScore(midi), '<Test> & "more"');
  assert.match(titled, /<work-title>&lt;Test&gt; &amp; &quot;more&quot;<\/work-title>/);
  assert.match(xml, /<part-name>A &amp; B &lt;1&gt;<\/part-name>/);
  assert.match(xml, /<instrument-name>Flute<\/instrument-name>/);
  assert.match(xml, /<midi-channel>4<\/midi-channel><midi-program>74<\/midi-program>/);
  assert.match(xml, /<divisions>12<\/divisions>/);
  assert.match(xml, /<duration>18<\/duration><voice>1<\/voice><type>quarter<\/type><dot\/>/);
  assert.match(xml, /<duration>6<\/duration><voice>1<\/voice><type>eighth<\/type>/);
  assert.match(xml, /<duration>24<\/duration><voice>1<\/voice><type>half<\/type>/);
  assert.match(xml, /<metronome><beat-unit>quarter<\/beat-unit><per-minute>120<\/per-minute><\/metronome>/);
  const rest = sound(buildScore(parseMIDI(smf([[...timed([[60, 0, 1920], [62, 3840, 1920]])]])))).xml;
  assert.match(rest, /<rest measure="yes"\/><duration>48<\/duration>/);
});

/* ---------- Limits and housekeeping ---------- */

test('too many staves is reported, and fewer parts fit', () => {
  const tracks = Array.from({length: 33}, (_, i) => [...program(73, i % 9), ...note(72, 480, i % 9)]);
  const midi = parseMIDI(smf(tracks));
  assert.equal(midi.parts.length, 33);
  assert.equal(new Set(midi.parts.map(p => p.name)).size, 33); // names stay unique
  assert.throws(() => buildScore(midi), {code: 'too-many-staves'});
  assert.equal(buildScore(midi, {parts: midi.parts.slice(0, 32).map(p => p.id)}).staffCount, 32);
});

test('random music keeps every note where it starts; damaged files never break the engine', () => {
  let seed = 20261115;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (low, high) => low + Math.floor(random() * (high - low + 1));
  const meters = [[4, 4], [3, 4], [6, 8], [2, 4], [5, 8], [12, 8], [2, 2], [7, 8]];
  const song = () => {
    const tracks = [];
    for (let t = 0, count = pick(1, 3); t < count; t++) {
      const channel = random() < 0.2 ? 9 : t, notes = [], extra = [];
      if (!t) for (let k = 0, tick = 0; k < pick(1, 3); k++, tick += pick(1, 8) * 480 * pick(1, 4)) {
        const [n, d] = meters[pick(0, meters.length - 1)];
        extra.push([tick, [255, 0x58, 4, n, Math.log2(d), 24, 8]], [tick, [255, 0x59, 2, pick(-7, 7) & 255, pick(0, 1)]]);
      }
      if (random() < 0.7) extra.push([0, [0xC0 | channel, pick(0, 127)]]);
      const played = random() < 0.4; // off-grid timing, as a performance would have
      for (let i = 0, tick = pick(0, 2) * 240, total = pick(5, 60); i < total; i++) {
        const step = [120, 160, 240, 60, 80, 480][pick(0, 5)], start = Math.max(0, tick + (played ? pick(-25, 25) : 0));
        const duration = Math.max(10, pick(1, random() < 0.3 ? 16 : 4) * step + (played ? pick(-40, 40) : 0));
        for (let c = 0, size = random() < 0.3 ? pick(2, 4) : 1; c < size; c++) notes.push([channel === 9 ? pick(35, 60) : pick(30, 96), start, duration]);
        if (random() > 0.25) tick += step * pick(1, 3);
      }
      tracks.push(timed(notes, {channel, extra}));
    }
    return smf(tracks, {division: [96, 192, 480, 960][pick(0, 3)]});
  };
  for (let i = 0; i < 60; i++) {
    const midi = parseMIDI(song());
    sound(buildScore(midi, {grid: [8, 16, 32][i % 3], triplets: i % 4 !== 0, simplify: i % 5 === 0 ? false : undefined, key: i % 7 === 0 ? pick(-7, 7) : undefined}));
    sound(buildScore(midi, {grid: 'auto'}));
    // Without triplets, every note is written at the grid position nearest to its start: none is lost, moved or invented.
    const plain = buildScore(midi, {grid: [8, 16, 32][i % 3], triplets: false, simplify: false}), U = plain.unitsPerQuarter;
    const expected = new Set(midi.parts.flatMap(part => part.notes.map(n => Math.round(n.start * U / midi.division / 3) * 3 + ':' + n.pitch)));
    assert.deepEqual(writtenOnsets(plain), [...expected].sort());
  }
  const base = song();
  for (let i = 0; i < 400; i++) {
    let bytes = Uint8Array.from(base);
    for (let k = pick(1, 6); k > 0; k--) bytes[pick(0, bytes.length - 1)] = pick(0, 255);
    if (random() < 0.2) bytes = bytes.slice(0, pick(0, bytes.length));
    try { const score = buildScore(parseMIDI(bytes)); toABC(score); toMusicXML(score); }
    catch (error) { assert.ok(error.code, `unexpected ${error.stack}`); } // only the engine's own, coded errors
  }
});

test('a large file converts quickly', () => {
  const notes = [];
  for (let i = 0; i < 28000; i++) notes.push([48 + (i * 7) % 36, i * 60, 60 + (i % 5) * 120]);
  const started = Date.now(), score = buildScore(parseMIDI(smf([[...timed(notes)]])));
  toABC(score); toMusicXML(score);
  assert.ok(score.measures.length > 800);
  assert.ok(Date.now() - started < 5000);
});

test('the web copy of the engine is identical to the source', () => {
  for (const file of ['engine.js', 'abcjs-basic-min.js']) {
    assert.ok(fs.readFileSync(path.join(__dirname, '../Staves/Resources', file)).equals(fs.readFileSync(path.join(__dirname, '../web/assets', file))), `${file}: run "npm run sync"`);
  }
});
