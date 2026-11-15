/* Parsing and quantization stay off the UI thread. */
importScripts('assets/engine.js');

// The last parsed file is kept, so changing an option does not re-send or re-parse the MIDI data.
let cached = {file: null, midi: null};

self.onmessage = ({data}) => {
  const {id, action, file, bytes, options, title} = data;
  try {
    if (bytes) cached = {file, midi: Staves.parseMIDI(new Uint8Array(bytes), {lang: 'zh'})};
    else if (cached.file !== file) throw Object.assign(Error('The file is no longer loaded.'), {code: 'not-loaded'});
    const midi = cached.midi;
    if (action === 'inspect') {
      self.postMessage({id, result: {
        parts: midi.parts.map(p => ({id: p.id, name: p.name, notes: p.notes.length, percussion: p.percussion, program: p.instrument.program, source: p.instrument.source})),
        notes: midi.parts.reduce((n, p) => n + p.notes.length, 0), meter: midi.meter, tempo: midi.tempo, key: midi.key
      }});
    } else {
      const score = Staves.buildScore(midi, options);
      self.postMessage({id, result: {
        abc: Staves.toABC(score, title), xml: Staves.toMusicXML(score, title),
        grid: score.grid, autoGrid: score.autoGrid, staves: score.staffCount, measures: score.measures.length, meter: score.meter, tempo: score.tempo, key: score.key,
        warnings: score.warnings
      }});
    }
  } catch (error) {
    self.postMessage({id, error: {code: error.code || '', message: error.message || 'MIDI 转换失败。'}});
  }
};
