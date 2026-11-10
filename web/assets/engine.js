/* Staves MIDI and notation core. No network access or platform dependencies. */
(function(root) {
'use strict';
const xml = s => String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
function parseMIDI(input) {
 const a = input instanceof Uint8Array ? input : new Uint8Array(input);
 let p=0, limit=a.length, events=0;
 const need=n=>{if(p+n>limit) throw Error('The MIDI file is truncated.');};
 const byte=()=>{need(1);return a[p++];};
 const u16=()=>byte()*256+byte();
 const u32=()=>byte()*16777216+byte()*65536+byte()*256+byte();
 const str=n=>{need(n);let s='';while(n--)s+=String.fromCharCode(a[p++]);return s;};
 const vlq=()=>{let v=0;for(let i=0;i<4;i++){const b=byte();v=v*128+(b&127);if(!(b&128))return v;}throw Error('Invalid MIDI variable-length value.');};
 if(str(4)!=='MThd')throw Error('Choose a Standard MIDI file (.mid or .midi).');
 const header=u32(); if(header<6)throw Error('Invalid MIDI header.');need(header);
 const format=u16(), trackCount=u16(), division=u16();p+=header-6;
 if(format>1)throw Error('MIDI format 2 contains independent sequences. Save it as format 0 or 1 first.');
 if(!division || division&32768)throw Error('SMPTE time-based MIDI is not supported. Export using musical ticks per beat.');
 if(!trackCount || trackCount>256)throw Error('Invalid or excessive MIDI track count.');
 const parts=[], meters=[], tempos=[], keys=[], warnings=[];
 const decoder=new TextDecoder('utf-8');
 for(let t=0;t<trackCount;t++){
  limit=a.length;if(str(4)!=='MTrk')throw Error('Missing MIDI track chunk.');const len=u32();need(len);const end=p+len;limit=end;
  let tick=0,running=0,name=`Track ${t+1}`;const active=new Map(), notes=[];
  const finish=(key,at)=>{const q=active.get(key);if(q?.length){const n=q.shift();n.duration=Math.max(1,at-n.start);notes.push(n);}};
  while(p<end){
   if(++events>1000000)throw Error('This MIDI file has too many events to display safely.');
   tick+=vlq();let status=byte();if(status<128){if(!running)throw Error('Invalid MIDI running status.');p--;status=running;}else if(status<240)running=status;
   if(status===255){running=0;const type=byte(),n=vlq();need(n);const d=a.slice(p,p+n);p+=n;
    if(type===3)name=decoder.decode(d).replace(/[\r\n\x00-\x1f]/g,' ').trim()||name;
    if(type===0x51&&n===3)tempos.push({tick,bpm:60000000/(d[0]*65536+d[1]*256+d[2])});
    if(type===0x58&&n>=2){if(!d[0]||d[1]>5)throw Error('Unsupported time signature.');meters.push({tick,numerator:d[0],denominator:2**d[1]});}
    if(type===0x59&&n===2){const fifths=d[0]>127?d[0]-256:d[0];if(Math.abs(fifths)>7)throw Error('Invalid MIDI key signature.');keys.push({tick,fifths,minor:!!d[1]});}
    if(type===0x2f){p=end;break;}continue;
   }
   if(status===240||status===247){running=0;const n=vlq();need(n);p+=n;continue;}
   if(status>=240)throw Error('Unsupported MIDI system event.');
   const kind=status>>4, channel=status&15, x=byte();if(x>127)throw Error('Invalid MIDI data byte.');
   const y=(kind===12||kind===13)?0:byte();if(y>127)throw Error('Invalid MIDI data byte.');
   if(kind===14)warnings.push('Pitch bends are not reflected in the written pitches.');
   if(kind===11&&x===64&&y>=64)warnings.push('Sustain-pedal extensions are not included; notation uses note-on and note-off durations.');
   const key=channel*128+x;
   if(kind===9&&y){if(!active.has(key))active.set(key,[]);active.get(key).push({pitch:x,start:tick,velocity:y,channel});}
   if(kind===8||(kind===9&&!y))finish(key,tick);
  }
  for(const [key,q] of active){if(q.length)warnings.push('Unclosed notes were ended at the end of their track.');while(q.length)finish(key,tick);}
  if(notes.length)for(const channel of [...new Set(notes.map(n=>n.channel))])parts.push({id:`${t}-${channel}`,name:name+(channel===9?' · percussion':channel?` · ch ${channel+1}`:''),channel,notes:notes.filter(n=>n.channel===channel).sort((a,b)=>a.start-b.start||a.pitch-b.pitch)});
  p=end;
 }
 if(!parts.length)throw Error('This MIDI file contains no notes.');
 if(parts.reduce((s,p)=>s+p.notes.length,0)>30000)throw Error('This file exceeds the 30,000-note limit. Split it into smaller files.');
 const sorted=x=>x.sort((a,b)=>a.tick-b.tick);sorted(meters);sorted(tempos);sorted(keys);
 if(meters.some(m=>m.tick>0))warnings.push('Time-signature changes are flattened to the opening meter.');
 if(keys.some(k=>k.tick>0))warnings.push('Key-signature changes are flattened to the opening key.');
 if(tempos.some(t=>t.tick>0))warnings.push('The score shows the opening tempo; later tempo changes are not included.');
 if(parts.some(p=>p.channel===9))warnings.push('Percussion is shown as pitched notes, not a drum-map transcription.');
 return {division,format,parts,meter:meters.find(m=>m.tick===0)||{numerator:4,denominator:4},tempo:Math.round(tempos.find(t=>t.tick===0)?.bpm||120),key:keys.find(k=>k.tick===0)||{fifths:0,minor:false},warnings:[...new Set(warnings)]};
}
const sharpNames=[['C',0],['C',1],['D',0],['D',1],['E',0],['F',0],['F',1],['G',0],['G',1],['A',0],['A',1],['B',0]];
const flatNames=[['C',0],['D',-1],['D',0],['E',-1],['E',0],['F',0],['G',-1],['G',0],['A',-1],['A',0],['B',-1],['B',0]];
function pitch(n,flat){const [step,alter]=(flat?flatNames:sharpNames)[n%12];return {step,alter,octave:Math.floor(n/12)-1};}
function buildScore(midi,options={}){
 const grid=Number(options.grid||16);if(![8,16,32].includes(grid))throw Error('Invalid quantization.');
 const unit=midi.division*4/grid, measureUnits=midi.meter.numerator*grid/midi.meter.denominator;
 if(!Number.isInteger(measureUnits))throw Error('Choose a finer quantization for this time signature.');
 const selected=options.parts||midi.parts.map(p=>p.id), voices=[];
 for(const part of midi.parts.filter(p=>selected.includes(p.id))){
  const notes=part.notes.map(n=>({...n,start:Math.round(n.start/unit),duration:Math.max(1,Math.round((n.start+n.duration)/unit)-Math.round(n.start/unit))}));
  const groups=[];for(const n of notes.sort((a,b)=>a.start-b.start||a.duration-b.duration||a.pitch-b.pitch)){
   const last=groups[groups.length-1];if(last&&last.start===n.start&&last.duration===n.duration&&!last.notes.some(x=>x.pitch===n.pitch))last.notes.push(n);else groups.push({start:n.start,duration:n.duration,notes:[n]});
  }
  const lanes=[];for(const g of groups){let lane=lanes.find(l=>l.end<=g.start);if(!lane){lane={end:0,groups:[]};lanes.push(lane);}lane.groups.push(g);lane.end=g.start+g.duration;}
  lanes.forEach((lane,i)=>voices.push({name:part.name+(lanes.length>1?` · voice ${i+1}`:''),clef:notes.reduce((s,n)=>s+n.pitch,0)/notes.length<60?'bass':'treble',groups:lane.groups}));
 }
 if(!voices.length)throw Error('Select at least one part.');
 if(voices.length>32)throw Error('This selection needs more than 32 staves. Select fewer parts.');
 const end=Math.max(...voices.map(v=>v.groups[v.groups.length-1]?.start+v.groups[v.groups.length-1]?.duration||0));
 const measures=Math.max(1,Math.ceil(end/measureUnits));if(measures>1000)throw Error('This score exceeds 1,000 measures. Split the MIDI file first.');
 for(const v of voices){v.measures=Array.from({length:measures},()=>[]);let at=0;
  const add=(start,duration,notes)=>{let pos=start,left=duration;while(left){const m=Math.floor(pos/measureUnits),available=Math.min(left,measureUnits-pos%measureUnits);let count=1;for(let power=1;power<=available;power*=2){count=Math.max(count,power);if(power*1.5<=available&&Number.isInteger(power*1.5))count=Math.max(count,power*1.5);}v.measures[m].push({duration:count,notes,tieIn:notes&&pos>start,tieOut:notes&&left>count});pos+=count;left-=count;}};
  for(const g of v.groups){if(g.start>at)add(at,g.start-at,null);add(g.start,g.duration,g.notes);at=g.start+g.duration;}if(at<measures*measureUnits)add(at,measures*measureUnits-at,null);
 }
 return {voices,measures,grid,measureUnits,meter:midi.meter,tempo:midi.tempo,key:midi.key,warnings:midi.warnings};
}
function toABC(score,title='Untitled'){
 const flat=score.key.fifths<0;
 const major=['Cb','Gb','Db','Ab','Eb','Bb','F','C','G','D','A','E','B','F#','C#'];
 const minor=['Abm','Ebm','Bbm','Fm','Cm','Gm','Dm','Am','Em','Bm','F#m','C#m','G#m','D#m','A#m'];
 const key=(score.key.minor?minor:major)[score.key.fifths+7]||'C';
 let out=`X:1\nT:${title.replace(/[\r\n]/g,' ')}\nM:${score.meter.numerator}/${score.meter.denominator}\nL:1/${score.grid}\nQ:1/4=${score.tempo}\n%%staffsep 65\n`;
 score.voices.forEach((v,i)=>out+=`V:${i+1} clef=${v.clef} name="${v.name.replace(/["\r\n\\]/g,' ')}"\n`);out+=`K:${key}\n`;
 const keyAlters={};const order=flat?'BEADGCF':'FCGDAEB';for(let i=0;i<Math.abs(score.key.fifths);i++)keyAlters[order[i]]=flat?-1:1;
 const note=(n,accidentals)=>{const p=pitch(n.pitch,flat);const id=p.step+p.octave;const previous=accidentals[id]??keyAlters[p.step]??0;accidentals[id]=p.alter;let s=p.octave>=5?p.step.toLowerCase()+"'".repeat(Math.max(0,p.octave-5)):p.step+','.repeat(Math.max(0,4-p.octave));return (p.alter===previous?'':p.alter===1?'^':p.alter===-1?'_':'=')+s;};
 score.voices.forEach((v,i)=>{out+=`[V:${i+1}]\n`;v.measures.forEach((bar,j)=>{const accidentals={};out+=bar.map(e=>{const n=e.notes?(e.notes.length===1?note(e.notes[0],accidentals):'['+e.notes.map(n=>note(n,accidentals)).join('')+']'):'z';return n+(e.duration===1?'':e.duration)+(e.tieOut?'-':'');}).join(' ')+(j===v.measures.length-1?' |]':' | ');if((j+1)%4===0)out+='\n';});out+='\n';});return out;
}
function toMusicXML(score,title='Untitled'){
 const divisions=score.grid/4, flat=score.key.fifths<0;
 let out=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="4.0"><work><work-title>${xml(title)}</work-title></work><identification><creator type="composer">Converted with Staves</creator></identification><part-list>`;
 score.voices.forEach((v,i)=>out+=`<score-part id="P${i+1}"><part-name>${xml(v.name)}</part-name></score-part>`);out+='</part-list>';
 score.voices.forEach((v,i)=>{out+=`<part id="P${i+1}">`;v.measures.forEach((bar,j)=>{out+=`<measure number="${j+1}">`;if(!j)out+=`<attributes><divisions>${divisions}</divisions><key><fifths>${score.key.fifths}</fifths><mode>${score.key.minor?'minor':'major'}</mode></key><time><beats>${score.meter.numerator}</beats><beat-type>${score.meter.denominator}</beat-type></time><clef><sign>${v.clef==='bass'?'F':'G'}</sign><line>${v.clef==='bass'?4:2}</line></clef></attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome></direction-type><sound tempo="${score.tempo}"/></direction>`;
 for(const e of bar){if(!e.notes){out+=`<note><rest/><duration>${e.duration}</duration></note>`;continue;}e.notes.forEach((n,k)=>{const p=pitch(n.pitch,flat);out+=`<note>${k?'<chord/>':''}<pitch><step>${p.step}</step><alter>${p.alter}</alter><octave>${p.octave}</octave></pitch><duration>${e.duration}</duration>${e.tieIn?'<tie type="stop"/>':''}${e.tieOut?'<tie type="start"/>':''}${e.tieIn||e.tieOut?`<notations>${e.tieIn?'<tied type="stop"/>':''}${e.tieOut?'<tied type="start"/>':''}</notations>`:''}</note>`;});}out+='</measure>';});out+='</part>';});return out+'</score-partwise>';
}
const api={parseMIDI,buildScore,toABC,toMusicXML};if(typeof module!=='undefined')module.exports=api;root.Staves=api;
})(typeof globalThis!=='undefined'?globalThis:this);
