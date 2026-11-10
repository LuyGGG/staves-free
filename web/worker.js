/* Parsing and quantization stay off the UI thread. */
importScripts('assets/engine.js');
self.onmessage = ({data}) => {
 const {id,action,bytes,options,title}=data;
 try {
  const midi=Staves.parseMIDI(new Uint8Array(bytes));
  if(action==='inspect'){
   self.postMessage({id,result:{parts:midi.parts.map(p=>({id:p.id,name:p.name,notes:p.notes.length})),notes:midi.parts.reduce((n,p)=>n+p.notes.length,0),meter:midi.meter,tempo:midi.tempo}});
  }else{
   const score=Staves.buildScore(midi,options);
   self.postMessage({id,result:{abc:Staves.toABC(score,title),xml:Staves.toMusicXML(score,title),voices:score.voices.length,measures:score.measures,meter:score.meter,tempo:score.tempo,warnings:score.warnings}});
  }
 }catch(error){self.postMessage({id,error:error.message||'MIDI 转换失败。'});}
};
