/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as Tone from 'tone';
import { 
  Play, 
  Square, 
  Trash2, 
  Download, 
  Save, 
  Plus, 
  Dices, 
  ChevronUp, 
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Activity
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as MidiWriter from 'midi-writer-js';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import audioBufferToWav from 'audiobuffer-to-wav';
import { Capacitor } from '@capacitor/core';

// --- Constants & Types ---

const SCALES = {
  'Major': [0, 2, 4, 5, 7, 9, 11],
  'Minor': [0, 2, 3, 5, 7, 8, 10],
  'Pentatonic': [0, 2, 4, 7, 9],
  'Blues': [0, 3, 5, 6, 7, 10],
  'Dorian': [0, 2, 3, 5, 7, 9, 10],
  'Phrygian': [0, 1, 3, 5, 7, 8, 10],
  'Mixolydian': [0, 2, 4, 5, 7, 9, 10],
  'Lydian': [0, 2, 4, 6, 7, 9, 11],
  'Locrian': [0, 1, 3, 5, 6, 8, 10],
  'Chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

const STYLES = [
  'Boris Brejcha', 'Amelie Lens', 'Claptone', 'Hozho', 'Dash Berlin', 
  'Deadmau5', 'Charlotte de Witte', 'KSHMR',
  'Tech House', 'Melodic Techno', 'Minimal Techno', 'High Tech Minimal',
  'Detroit Techno', 'Berlin Techno', 'Acid Techno', 'Trance', 'Psytrance',
  'Drum and Bass', 'Hardstyle', 'Acid House', 'Cyberpunk'
];

// --- Factory Data Generator ---
// We keep this outside the component so it's stable across re-renders
const FACTORY_BANKS: Bank[] = ((): Bank[] => {
  const factoryBanks: Bank[] = [];
  
  STYLES.forEach((styleName, sIdx) => {
    const patterns: Pattern[] = [];
    for (let i = 0; i < 128; i++) {
      const scaleNotes = SCALES['Phrygian'];
      const steps: Step[] = Array(16).fill(null).map((_, stepIdx) => {
        const isActive = Math.random() < 0.6;
        return {
          note: scaleNotes[Math.floor(Math.random() * scaleNotes.length)],
          octave: Math.random() < 0.2 ? 2 : 1,
          accent: Math.random() < 0.3,
          slide: Math.random() < 0.2,
          active: isActive
        };
      });
      patterns.push({
        id: `factory-${sIdx}-${i}`,
        name: `${styleName} Lvl ${i + 1}`,
        bpm: 120 + Math.floor(Math.random() * 40),
        steps
      });
    }
    factoryBanks.push({
      id: `factory-bank-${sIdx}`,
      name: `Factory: ${styleName}`,
      patterns
    });
  });

  return factoryBanks;
})();

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

interface Step {
  note: number; // 0-11
  octave: number; // 0-2 (relative to base)
  accent: boolean;
  slide: boolean;
  active: boolean;
}

interface Pattern {
  id: string;
  name: string;
  steps: Step[];
  bpm: number;
}

interface Bank {
  id: string;
  name: string;
  patterns: Pattern[];
}

// --- Components ---

const Knob = ({ 
  label, 
  value, 
  min, 
  max, 
  onChange, 
  step = 1,
  unit = "" 
}: { 
  label: string; 
  value: number; 
  min: number; 
  max: number; 
  onChange: (val: number) => void;
  step?: number;
  unit?: string;
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const startVal = useRef(0);

  const handlePointerDown = (e: React.PointerEvent) => {
    setIsDragging(true);
    startY.current = e.clientY;
    startVal.current = value;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (!isDragging) return;
    const deltaY = startY.current - e.clientY;
    const range = max - min;
    const factor = range / 200; // Sensitivity
    const newVal = Math.min(max, Math.max(min, startVal.current + deltaY * factor));
    onChange(Math.round(newVal / step) * step);
  }, [min, max, onChange, step, isDragging]);

  const handlePointerUp = useCallback((e: PointerEvent) => {
    setIsDragging(false);
  }, []);

  const percentage = ((value - min) / (max - min)) * 100;
  const rotation = -135 + (percentage * 2.7);

  return (
    <div 
      className="flex flex-col items-center gap-3 cursor-ns-resize select-none touch-none" 
      onPointerDown={handlePointerDown}
      onPointerMove={(e) => handlePointerMove(e.nativeEvent)}
      onPointerUp={(e) => handlePointerUp(e.nativeEvent)}
    >
      <div className="knob-outer group">
        <div 
          className="knob-indicator transition-transform duration-75"
          style={{ transform: `rotate(${rotation}deg)` }}
        />
        <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-black/20 to-transparent pointer-events-none" />
      </div>
      <div className="flex flex-col items-center">
        <span className="text-[10px] uppercase tracking-widest text-[#666] mb-0.5">
          {label}
        </span>
        <span className="text-[9px] font-mono text-[#F27D26]/80">
          {value.toFixed(step >= 1 ? 0 : 2)}{unit}
        </span>
      </div>
    </div>
  );
};

export default function App() {
  // --- Audio State ---
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(128);
  const [currentStepIdx, setCurrentStepIdx] = useState(-1);
  const [waveform, setWaveform] = useState<'sawtooth' | 'square'>('sawtooth');
  
  // --- Parameters ---
  const [tuning, setTuning] = useState(0);
  const [cutoff, setCutoff] = useState(3000);
  const [resonance, setResonance] = useState(0.6);
  const [envMod, setEnvMod] = useState(0.5);
  const [decay, setDecay] = useState(0.3);
  const [accentAmt, setAccentAmt] = useState(0.8);
  const [drive, setDrive] = useState(10);
  const [reverbMix, setReverbMix] = useState(0.2);

  // --- Sequencer State ---
  const [banks, setBanks] = useState<Bank[]>([]);
  const [activeBankId, setActiveBankId] = useState('');
  const [activePatternId, setActivePatternId] = useState('');
  const [root, setRoot] = useState('C');
  const [scale, setScale] = useState('Phrygian');
  const [style, setStyle] = useState('Acid Techno');
  const [patternName, setPatternName] = useState('');

  // --- Refs for continuous Audio control ---
  const synthRef = useRef<Tone.MonoSynth | null>(null);
  const filterRef = useRef<Tone.Filter | null>(null);
  const distRef = useRef<Tone.Distortion | null>(null);
  const reverbRef = useRef<Tone.Reverb | null>(null);
  const patternRef = useRef<Pattern | null>(null);
  const tuningRef = useRef(0);
  const cutoffRef = useRef(3000);
  const accentRef = useRef(0.8);
  const decayRef = useRef(0.3);

  // --- Initialization ---
  useEffect(() => {
    // Audio Chain
    const dist = new Tone.Distortion(0).toDestination();
    
    // Reverb with requested filtering
    const reverbLp = new Tone.Filter(4000, 'lowpass').connect(dist);
    const reverbHp = new Tone.Filter(300, 'highpass').connect(reverbLp);
    const reverb = new Tone.Reverb({
      decay: 2.5,
      preDelay: 0.01,
      wet: 0.2
    }).connect(reverbHp);
    
    const filter = new Tone.Filter({
      frequency: 3000,
      type: "lowpass",
      rolloff: -24,
      Q: 5
    }).connect(dist);

    const synth = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: {
        attack: 0.005,
        decay: 0.3,
        sustain: 0,
        release: 0.1
      },
      filterEnvelope: {
        attack: 0.005,
        decay: 0.3,
        sustain: 0,
        release: 0.1,
        baseFrequency: 30,
        octaves: 7,
        exponent: 2
      }
    }).connect(filter);

    synthRef.current = synth;
    filterRef.current = filter;
    distRef.current = dist;
    reverbRef.current = reverb;
    
    // Connect reverb in parallel to main output or via send?
    // Let's connect filter to reverb too for that "Spacey Acid" feel
    filter.connect(reverb);

    // Load initial data
    const savedBanks = localStorage.getItem('acid303_banks_v2');
    const factory = FACTORY_BANKS;
    
    if (savedBanks) {
      const parsed = JSON.parse(savedBanks);
      // Merge factory with user banks
      const merged = [...factory, ...parsed];
      setBanks(merged);
      if (merged.length > 0) {
        setActiveBankId(merged[0].id);
        if (merged[0].patterns.length > 0) {
          setActivePatternId(merged[0].patterns[0].id);
        }
      }
    } else {
      setBanks(factory);
      setActiveBankId(factory[0].id);
      setActivePatternId(factory[0].patterns[0].id);
    }

    return () => {
      Tone.Transport.stop();
      synth.dispose();
      filter.dispose();
      dist.dispose();
      reverb.dispose();
    };
  }, []);

  // --- Pattern Management ---
  const activePattern = useMemo(() => {
    const bank = banks.find(b => b.id === activeBankId);
    return bank?.patterns.find(p => p.id === activePatternId);
  }, [banks, activeBankId, activePatternId]);

  useEffect(() => {
    patternRef.current = activePattern || null;
  }, [activePattern]);

  useEffect(() => {
    tuningRef.current = tuning;
  }, [tuning]);

  useEffect(() => {
    cutoffRef.current = cutoff;
  }, [cutoff]);

  useEffect(() => {
    accentRef.current = accentAmt;
  }, [accentAmt]);

  useEffect(() => {
    decayRef.current = decay;
  }, [decay]);

  // --- Parameter Sync ---
  useEffect(() => {
    if (!synthRef.current || !filterRef.current || !distRef.current || !reverbRef.current) return;
    
    synthRef.current.oscillator.type = waveform;
    filterRef.current.frequency.value = cutoff;
    filterRef.current.Q.value = resonance * 30; // Scale resonance
    distRef.current.distortion = drive / 100;
    reverbRef.current.wet.value = reverbMix;

    synthRef.current.envelope.decay = decay;
    synthRef.current.filterEnvelope.decay = decay;
    synthRef.current.filterEnvelope.octaves = envMod * 7 + 1;

  }, [waveform, cutoff, resonance, drive, reverbMix, envMod, decay]);

  useEffect(() => {
    Tone.Transport.bpm.value = bpm;
  }, [bpm]);

  const updateStep = (index: number, updates: Partial<Step>) => {
    setBanks(prev => prev.map(bank => {
      if (bank.id !== activeBankId) return bank;
      return {
        ...bank,
        patterns: bank.patterns.map(p => {
          if (p.id !== activePatternId) return p;
          const newSteps = [...p.steps];
          newSteps[index] = { ...newSteps[index], ...updates };
          return { ...p, steps: newSteps };
        })
      };
    }));
  };

  // --- Transport Logic ---
  const startSequencer = async () => {
    await Tone.start();
    if (isPlaying) {
      Tone.Transport.stop();
      Tone.Transport.cancel();
      setIsPlaying(false);
      setCurrentStepIdx(-1);
      return;
    }

    Tone.Transport.cancel();
    let stepCount = 0;

    Tone.Transport.scheduleRepeat((time) => {
      const p = patternRef.current;
      if (!p) return;
      const idx = stepCount % 16;
      const step = p.steps[idx];
      
      // Update UI in next tick to avoid heavy audio logic blocking
      Tone.Draw.schedule(() => setCurrentStepIdx(idx), time);

      if (step.active) {
        // Octave 1, 2, 3 selection support
        const freq = Tone.Frequency(NOTES[step.note] + step.octave).transpose(tuningRef.current);
        const pitch = freq.toNote();

        // Accent logic
        if (step.accent) {
           filterRef.current?.frequency.rampTo(cutoffRef.current * (1 + accentRef.current), "32n", time);
           synthRef.current?.envelope.set({ attack: 0.001, decay: decayRef.current * 0.8 });
        } else {
           filterRef.current?.frequency.rampTo(cutoffRef.current, "32n", time);
           synthRef.current?.envelope.set({ attack: 0.005, decay: decayRef.current });
        }

        // Slide logic (Portamento)
        if (synthRef.current) {
          synthRef.current.portamento = step.slide ? 0.05 : 0.001;
        }
        
        synthRef.current?.triggerAttackRelease(pitch, "16n", time);
      }
      
      stepCount++;
    }, "16n");

    Tone.Transport.start();
    setIsPlaying(true);
  };

  const clearPattern = () => {
    if (!activePatternId) return;
    setBanks(prev => prev.map(b => ({
      ...b,
      patterns: b.patterns.map(p => p.id === activePatternId ? {
        ...p,
        steps: Array(16).fill(null).map(() => ({ note: 0, octave: 1, accent: false, slide: false, active: false }))
      } : p)
    })));
  };

  const generateRandom = () => {
    const scaleNotes = SCALES[scale as keyof typeof SCALES];
    
    // Style-based probability settings
    let density = 0.5;
    let accentProb = 0.2;
    let slideProb = 0.2;
    let octaveProb = 0.2;
    let rhythmType = 'random'; // 'random', 'syncopated', 'minimal', 'driving'

    if (style.includes('Minimal') || style.includes('Brejcha') || style.includes('Hozho')) {
      density = 0.3; rhythmType = 'minimal'; accentProb = 0.1;
    } else if (style.includes('Techno') || style.includes('Lens') || style.includes('Witte')) {
      density = 0.7; rhythmType = 'driving'; accentProb = 0.3; slideProb = 0.1;
    } else if (style.includes('Acid')) {
      density = 0.6; rhythmType = 'syncopated'; slideProb = 0.4; accentProb = 0.4;
    } else if (style.includes('Trance')) {
      density = 0.8; rhythmType = 'driving'; octaveProb = 0.5;
    }

    const newSteps = Array(16).fill(null).map((_, i) => {
      let active = Math.random() < density;
      
      // Rhythm enforcement
      if (rhythmType === 'driving' && i % 2 !== 0 && Math.random() > 0.3) active = false;
      if (rhythmType === 'minimal' && i % 4 !== 0 && Math.random() > 0.2) active = false;

      const noteOffset = scaleNotes[Math.floor(Math.random() * scaleNotes.length)];
      return {
        note: noteOffset,
        octave: Math.random() < octaveProb ? 2 : 1,
        accent: Math.random() < accentProb,
        slide: Math.random() < slideProb,
        active
      };
    });

    setBanks(prev => prev.map(b => ({
      ...b,
      patterns: b.patterns.map(p => p.id === activePatternId ? { ...p, steps: newSteps } : p)
    })));
  };

  const downloadMidi = async () => {
    if (!activePattern) return;
    
    // Track 0: Meta events (Tempo, etc)
    const metaTrack = new MidiWriter.Track();
    metaTrack.addEvent(new MidiWriter.TempoEvent({ bpm: bpm }));
    metaTrack.addEvent(new MidiWriter.TimeSignatureEvent(4, 4));

    // Track 1: Notes
    const noteTrack = new MidiWriter.Track();
    noteTrack.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: 39 })); // Synth Bass 2

    activePattern.steps.forEach((step, i) => {
      if (step.active) {
        // Calculate the transposed note name to match Tone.js playback
        const baseNote = NOTES[step.note] + step.octave;
        const transposedPitch = Tone.Frequency(baseNote).transpose(tuning).toNote();
        
        // Duration: if slide is active, note lasts longer to create legato feel
        const duration = step.slide ? '8' : '16';
        
        // Velocity: accents get higher velocity
        const velocity = step.accent ? 127 : 90;

        noteTrack.addEvent(new MidiWriter.NoteEvent({
            pitch: [transposedPitch],
            duration: duration,
            velocity: velocity,
            startTick: i * 32 // 32 ticks per 16th note when PPQ is 128 (MidiWriter default)
        }));
      }
    });

    // Formats: Passing array of tracks usually results in Format 1
    const write = new MidiWriter.Writer([metaTrack, noteTrack]);
    const fileName = `${activePattern.name || 'acid_303'}.mid`;
    const dataUri = write.dataUri();
    const base64Data = dataUri.split(',')[1];

    if (Capacitor.isNativePlatform()) {
      try {
        const savedFile = await Filesystem.writeFile({
          path: fileName,
          data: base64Data,
          directory: Directory.Cache,
        });

        await Share.share({
          title: 'Export MIDI',
          url: savedFile.uri,
          dialogTitle: 'Share MIDI file',
        });
      } catch (e) {
        console.error('Error sharing MIDI', e);
        alert('Could not share MIDI file');
      }
    } else {
      const link = document.createElement('a');
      link.href = write.dataUri();
      link.download = fileName;
      link.click();
    }
  };

  const downloadWav = async () => {
    if (!activePattern) return;
    
    const duration = 16 * (60 / bpm / 4) + 0.5; // 16 steps + tail
    
    // Render!
    const buffer = await Tone.Offline(() => {
       const d = new Tone.Distortion(drive / 100).toDestination();
       const f = new Tone.Filter({
         frequency: cutoff,
         type: "lowpass",
         rolloff: -24,
         Q: resonance * 30
       }).connect(d);

       const s = new Tone.MonoSynth({
         oscillator: { type: waveform },
         envelope: { attack: 0.005, decay: decay, sustain: 0, release: 0.1 },
         filterEnvelope: { 
           attack: 0.005, decay: decay, sustain: 0, release: 0.1, 
           baseFrequency: 30, octaves: envMod * 7 + 1, exponent: 2 
         }
       }).connect(f);
       
       activePattern.steps.forEach((step, i) => {
         if (step.active) {
           const startTime = i * (60 / bpm / 4);
           const pitch = Tone.Frequency(NOTES[step.note] + step.octave).transpose(tuning).toNote();
           
           if (step.accent) {
             f.frequency.setValueAtTime(cutoff * (1 + accentAmt), startTime);
           } else {
             f.frequency.setValueAtTime(cutoff, startTime);
           }

           s.portamento = step.slide ? 0.05 : 0.001;
           s.triggerAttackRelease(pitch, "16n", startTime);
         }
       });
    }, duration);

    // Convert AudioBuffer to WAV
    const wavData = audioBufferToWav(buffer);
    const blob = new Blob([new DataView(wavData)], { type: 'audio/wav' });
    const fileName = `${activePattern.name || 'acid_303'}.wav`;

    if (Capacitor.isNativePlatform()) {
      try {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = async () => {
          const base64data = (reader.result as string).split(',')[1];
          const savedFile = await Filesystem.writeFile({
            path: fileName,
            data: base64data,
            directory: Directory.Cache,
          });

          await Share.share({
            title: 'Export WAV',
            url: savedFile.uri,
            dialogTitle: 'Share WAV file',
          });
        };
      } catch (e) {
        alert('Could not share WAV file');
      }
    } else {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
    }
  };

  const saveToLocal = () => {
    const name = prompt("Enter Pattern Name:", activePattern?.name || "");
    if (!name) return;
    
    setBanks(prev => prev.map(b => {
      if (b.id !== activeBankId) return b;
      return {
        ...b,
        patterns: b.patterns.map(p => p.id === activePatternId ? { ...p, name } : p)
      };
    }));
    
    // We save user banks separately from factory in localStorage logic
    const userBanks = banks.filter(b => !b.id.startsWith('factory-'));
    localStorage.setItem('acid303_banks_v2', JSON.stringify(userBanks));
    alert("Pattern Saved!");
  };

  const addBank = () => {
    const name = prompt("Enter Soundbank Name:", "My New Bank");
    if (!name) return;

    const newBank: Bank = {
      id: "bank-" + Date.now(),
      name: name,
      patterns: [{
        id: 'pat-' + Date.now(),
        name: 'New Pattern',
        bpm: 128,
        steps: Array(16).fill(null).map(() => ({ note: 0, octave: 1, accent: false, slide: false, active: false }))
      }]
    };
    setBanks([...banks, newBank]);
    setActiveBankId(newBank.id);
    setActivePatternId(newBank.patterns[0].id);
  };

  const delPattern = () => {
     setBanks(prev => prev.map(b => ({
       ...b,
       patterns: b.patterns.filter(p => p.id !== activePatternId)
     })));
     setActivePatternId('');
  };

  const activeStepStyle = (i: number) => {
    const step = activePattern?.steps[i];
    if (!step) return '';
    const isActive = step.active;
    const isCurrent = currentStepIdx === i;

    // Use theme classes
    let base = "step-cell cursor-pointer ";
    if (isCurrent) base += "ring-1 ring-[#F27D26]/50 ";
    return base;
  };

  return (
    <div className="min-h-screen bg-[#0A0A0B] flex items-center justify-center p-4 font-sans overflow-hidden">
      <div id="app" className="max-w-[1024px] w-full min-h-[768px] bg-gradient-to-b from-[#121214] to-[#0A0A0B] border border-[#1A1A1C] rounded shadow-2xl flex flex-col gap-6 p-8 relative select-none">
        
        {/* Header Section */}
        <div className="flex justify-between items-end">
          <div className="flex flex-col">
            <h1 className="text-2xl font-serif italic text-white tracking-[0.2em] leading-none uppercase">TB-303 Evolution</h1>
            <p className="text-[9px] uppercase tracking-[4px] text-zinc-600 mt-2">Acid Bassline Synthesizer & Sequencer</p>
          </div>
          <div className="flex gap-4">
            <button 
              onClick={startSequencer}
              className={`btn ${isPlaying ? 'btn-active' : ''}`}
            >
              {isPlaying ? 'Stop' : 'Run'}
            </button>
            <button onClick={clearPattern} className="btn">Clear</button>
            <button onClick={downloadMidi} className="btn">Midi</button>
            <button onClick={downloadWav} className="btn">Wav</button>
          </div>
        </div>

        {/* Display Panel */}
        <div className="display-panel h-[110px] px-8 py-4 select-none">
          <div className="flex flex-col flex-1 min-w-[200px]">
            <span className="text-[10px] uppercase tracking-widest text-[#666] mb-1">Pattern Select</span>
            <select 
              value={activePatternId}
              onChange={(e) => setActivePatternId(e.target.value)}
              className="bg-transparent border-none text-xl font-bold text-[#F27D26] focus:outline-none cursor-pointer appearance-none hover:text-white transition-colors"
            >
              {banks.find(b => b.id === activeBankId)?.patterns.map(p => (
                <option key={p.id} value={p.id} className="bg-[#0A0A0B] text-[#F27D26]">{p.name || "Unnamed"}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-12 justify-center flex-1">
            <div className="flex flex-col items-center">
              <span className="text-[10px] uppercase tracking-widest text-[#666] mb-1">Note</span>
              <span className="text-xl font-bold text-white w-12 text-center">
                {currentStepIdx >= 0 && activePattern?.steps[currentStepIdx].active 
                  ? NOTES[activePattern.steps[currentStepIdx].note] + activePattern.steps[currentStepIdx].octave
                  : "--"}
              </span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-[10px] uppercase tracking-widest text-[#666] mb-1">Tempo</span>
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => setBpm(b => Math.max(20, b - 1))}
                  className="w-8 h-8 flex items-center justify-center bg-[#111] border border-[#333] text-[#F27D26] rounded-full hover:bg-[#222] transition-colors font-bold text-xl"
                >
                  -
                </button>
                <div className="flex flex-col items-center">
                  <input 
                    type="number"
                    value={bpm}
                    onChange={(e) => setBpm(Number(Math.min(300, Math.max(20, Number(e.target.value)))))}
                    className="bg-transparent border-none text-xl font-bold text-[#F27D26] w-16 text-center focus:outline-none focus:ring-1 focus:ring-[#F27D26]/20 rounded"
                  />
                </div>
                <button 
                  onClick={() => setBpm(b => Math.min(300, b + 1))}
                  className="w-8 h-8 flex items-center justify-center bg-[#111] border border-[#333] text-[#F27D26] rounded-full hover:bg-[#222] transition-colors font-bold text-xl"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-col text-right flex-1 min-w-[200px]">
            <span className="text-[10px] uppercase tracking-widest text-[#666] mb-1">Bank Select</span>
            <select 
              value={activeBankId}
              onChange={(e) => setActiveBankId(e.target.value)}
              className="bg-transparent border-none text-xl font-bold text-[#F27D26] focus:outline-none cursor-pointer appearance-none text-right hover:text-white transition-colors"
            >
              {banks.map(b => (
                <option key={b.id} value={b.id} className="bg-[#0A0A0B] text-[#F27D26]">{b.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Knobs Section */}
        <div className="flex justify-between items-center bg-[#111] p-6 border border-[#1A1A1C] rounded-lg">
          <div className="flex gap-8">
            <Knob label="Tuning" min={-12} max={12} value={tuning} onChange={setTuning} unit="st" />
            <Knob label="Cutoff" min={50} max={6000} value={cutoff} onChange={setCutoff} unit="hz" />
            <Knob label="Reso" min={0} max={1} value={resonance} onChange={setResonance} step={0.01} />
            <Knob label="Env Mod" min={0} max={1} value={envMod} onChange={setEnvMod} step={0.01} />
            <Knob label="Decay" min={0.05} max={1.5} value={decay} onChange={setDecay} step={0.01} unit="s" />
            <Knob label="Accent" min={0} max={1} value={accentAmt} onChange={setAccentAmt} step={0.01} />
          </div>
          <div className="h-16 w-[1px] bg-[#222]"></div>
          <div className="flex gap-8">
            <Knob label="Drive" min={0} max={100} value={drive} onChange={setDrive} unit="%" />
            <Knob label="Reverb" min={0} max={1} value={reverbMix} onChange={setReverbMix} step={0.01} />
          </div>
        </div>

        {/* FX / Choice Panel */}
        <div className="fx-panel items-center justify-between select-auto">
          <div className="flex gap-8 items-center">
            <div className="flex flex-col gap-1 w-32">
              <label className="text-[10px] text-[#555] uppercase tracking-widest">Waveform</label>
              <div className="flex gap-1 h-10 p-1 bg-[#111] rounded border border-[#333]">
                <button 
                  onClick={() => setWaveform('sawtooth')}
                  className={`flex-1 text-[10px] uppercase font-bold rounded ${waveform === 'sawtooth' ? 'bg-[#F27D26] text-black' : 'text-[#555] hover:text-white'}`}
                >
                  Saw
                </button>
                <button 
                  onClick={() => setWaveform('square')}
                  className={`flex-1 text-[10px] uppercase font-bold rounded ${waveform === 'square' ? 'bg-[#F27D26] text-black' : 'text-[#555] hover:text-white'}`}
                >
                  Sq
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1 w-32">
              <label className="text-[10px] text-[#555] uppercase tracking-widest">Root / Scale</label>
              <div className="flex gap-1">
                <select value={root} onChange={e => setRoot(e.target.value)} className="bg-[#111] border border-[#333] text-[#AAA] h-10 px-2 text-[11px] rounded flex-1">
                  {NOTES.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <select value={scale} onChange={e => setScale(e.target.value)} className="bg-[#111] border border-[#333] text-[#AAA] h-10 px-2 text-[11px] rounded flex-1">
                  {Object.keys(SCALES).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div className="flex flex-col gap-1 w-48">
              <label className="text-[10px] text-[#555] uppercase tracking-widest">Style / Genre</label>
              <select value={style} onChange={e => setStyle(e.target.value)} className="bg-[#111] border border-[#333] text-[#AAA] h-10 px-2 text-[11px] rounded">
                {STYLES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="flex items-end gap-3 justify-end">
            <button onClick={generateRandom} className="btn h-12 px-8 border-[#F27D26] text-[#F27D26] text-[12px]">Randomize Sequence</button>
            <button onClick={saveToLocal} className="btn h-12 px-6 text-[12px]">Save Pattern</button>
            <button onClick={addBank} className="btn h-12 px-6 text-[12px]">+ Bank</button>
          </div>
        </div>

        {/* Step Sequencer Grid */}
        <div className="flex-1">
          <div className="grid grid-cols-8 lg:grid-cols-16 gap-2">
            {(activePattern?.steps || []).map((step, i) => (
              <div 
                key={i} 
                className={activeStepStyle(i)}
                onPointerDown={(e) => {
                  // Only toggle if clicking the main area or led
                  if ((e.target as HTMLElement).closest('.note-controls') || (e.target as HTMLElement).closest('.modifier-controls')) return;
                  updateStep(i, { active: !step.active });
                }}
              >
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[9px] text-[#444] font-mono">0{i + 1}</span>
                  <div className={`w-2 h-2 rounded-full ${step.active ? 'bg-[#F27D26] shadow-[0_0_4px_#F27D26]' : 'bg-[#222]'}`}></div>
                </div>
                <div className={`step-led ${step.active ? 'step-led-active' : ''}`}></div>
                
                <div className="note-key select-none h-16 flex flex-col items-center justify-center gap-1 group note-controls relative">
                  {step.active ? (
                    <>
                      <span className="text-[11px] font-bold text-white mb-1">{NOTES[step.note]}{step.octave}</span>
                      <div className="grid grid-cols-2 gap-1 w-full px-1" onClick={e => e.stopPropagation()}>
                         <button 
                          onPointerDown={(e) => { 
                            e.stopPropagation(); 
                            // Cycle octaves 1, 2, 3
                            const nextOctave = step.octave >= 3 ? 1 : step.octave + 1;
                            updateStep(i, { octave: nextOctave }); 
                          }} 
                          className="h-8 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 text-white rounded transition-colors touch-none"
                        >
                          Oct+
                        </button>
                         <button 
                          onPointerDown={(e) => { 
                            e.stopPropagation(); 
                            updateStep(i, { note: (step.note + 1) % 12 });
                          }} 
                          className="h-8 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 text-white rounded transition-colors touch-none"
                        >
                          Note+
                        </button>
                      </div>
                    </>
                  ) : (
                    <span className="text-[8px] text-zinc-800">--</span>
                  )}
                </div>

                <div className="flex gap-1 mt-2 modifier-controls" onClick={e => e.stopPropagation()}>
                  <button 
                    onPointerDown={(e) => { e.stopPropagation(); updateStep(i, { accent: !step.accent }) }}
                    className={`h-6 flex-1 rounded-sm transition-all ${step.accent ? 'bg-[#F27D26]' : 'bg-[#222]'}`}
                    title="Accent"
                  />
                  <button 
                    onPointerDown={(e) => { e.stopPropagation(); updateStep(i, { slide: !step.slide }) }}
                    className={`h-6 flex-1 rounded-sm transition-all ${step.slide ? 'bg-[#00FF00]' : 'bg-[#222]'}`}
                    title="Slide"
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex justify-between items-center text-[10px] text-zinc-600 uppercase tracking-widest">
            <div>Accent / Slide Control Active</div>
            <div className="flex gap-8">
              <span className="flex items-center gap-2 font-bold"><div className="w-2 h-2 rounded-full bg-[#F27D26]" /> Accent</span>
              <span className="flex items-center gap-2 font-bold"><div className="w-2 h-2 rounded-full bg-[#00FF00]" /> Slide</span>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
