
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, FunctionDeclaration, Type } from '@google/genai';
import { UserProfile, WorkoutSession, WorkoutState, ExperienceLevel, FitnessGoal, CoachStyle, Difficulty, Exercise } from './types';
import Dashboard from './components/Dashboard';
import Onboarding from './components/Onboarding';
import WorkoutSessionView from './components/WorkoutSessionView';
import { getRecommendedWorkout, EXERCISES, adjustExerciseByDifficulty } from './services/workoutService';
import { createBlob, decode, decodeAudioData } from './utils/audio';

// Constants
const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;

const App: React.FC = () => {
  // State
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    const saved = localStorage.getItem('titan_profile');
    return saved ? JSON.parse(saved) : null;
  });
  const [history, setHistory] = useState<WorkoutSession[]>(() => {
    const saved = localStorage.getItem('titan_history');
    return saved ? JSON.parse(saved) : [];
  });
  const [isWorkoutActive, setIsWorkoutActive] = useState(false);
  const [workoutState, setWorkoutState] = useState<WorkoutState>({
    isActive: false,
    currentExerciseIndex: 0,
    currentSet: 1,
    timer: 0,
    isResting: false,
  });
  const [activeExercises, setActiveExercises] = useState<Exercise[]>([]);
  const [transcription, setTranscription] = useState('');
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);

  // Refs for Audio
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const timerIntervalRef = useRef<number | null>(null);

  // Persistence
  useEffect(() => {
    if (profile) localStorage.setItem('titan_profile', JSON.stringify(profile));
  }, [profile]);

  useEffect(() => {
    localStorage.setItem('titan_history', JSON.stringify(history));
  }, [history]);

  // Session Management
  const stopWorkout = useCallback(() => {
    setIsWorkoutActive(false);
    setWorkoutState(prev => ({ ...prev, isActive: false }));
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    // Log history
    const newSession: WorkoutSession = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      exercises: activeExercises.map(ex => ({
        exerciseId: ex.id,
        sets: Array(ex.targetSets).fill({ reps: ex.targetReps })
      }))
    };
    setHistory(prev => [newSession, ...prev]);
  }, [activeExercises]);

  const handleDifficultyChange = useCallback((newDifficulty: Difficulty) => {
    setActiveExercises(prev => {
      const updated = [...prev];
      const currentIdx = workoutState.currentExerciseIndex;
      if (updated[currentIdx]) {
        updated[currentIdx] = adjustExerciseByDifficulty(updated[currentIdx], newDifficulty);
      }
      return updated;
    });
    
    // Inform model
    if (sessionRef.current) {
      const currentEx = activeExercises[workoutState.currentExerciseIndex];
      const updatedEx = adjustExerciseByDifficulty(currentEx, newDifficulty);
      sessionRef.current.sendRealtimeInput({
        text: `The user changed difficulty to ${newDifficulty}. New goals: ${updatedEx.targetReps} reps, ${updatedEx.targetSets} sets.`
      });
    }
  }, [workoutState.currentExerciseIndex, activeExercises]);

  const handleStartWorkout = async () => {
    if (!profile) return;
    setIsWorkoutActive(true);
    const initialExercises = getRecommendedWorkout(profile.goal, profile.experience);
    setActiveExercises(initialExercises);
    setWorkoutState({
      isActive: true,
      currentExerciseIndex: 0,
      currentSet: 1,
      timer: 0,
      isResting: false,
    });

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    // Tools
    const controlTrainer: FunctionDeclaration = {
      name: 'updateWorkoutState',
      parameters: {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, description: 'The action: "finish_set", "next_exercise", "set_difficulty"' },
          value: { type: Type.STRING, description: 'Difficulty level for set_difficulty' }
        },
        required: ['action']
      }
    };

    const sessionPromise = ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-09-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { 
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } 
        },
        tools: [{ functionDeclarations: [controlTrainer] }],
        systemInstruction: `You are Titan, a ${profile.coachStyle} elite trainer. 
        Focus: Hands-free workout guidance. 
        Rules:
        1. When user reports "too easy" or "too hard", call 'set_difficulty'.
        2. When a set ends, call 'finish_set'.
        3. Keep form cues short and motivating.
        4. No unnecessary chatter during sets. Focus on breathing and pace.`
      },
      callbacks: {
        onopen: async () => {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
          audioContextRef.current = new AudioContextClass({ sampleRate: SAMPLE_RATE_IN });
          const source = audioContextRef.current.createMediaStreamSource(stream);
          const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
          
          processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            const pcmBlob = createBlob(inputData);
            sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
          };

          source.connect(processor);
          processor.connect(audioContextRef.current.destination);
          
          outputAudioContextRef.current = new AudioContextClass({ sampleRate: SAMPLE_RATE_OUT });
        },
        onmessage: async (msg: LiveServerMessage) => {
          if (msg.serverContent?.outputTranscription) {
            setTranscription(msg.serverContent.outputTranscription.text);
          } else if (msg.serverContent?.turnComplete) {
            setTimeout(() => setTranscription(''), 3000);
          }

          const audioBase64 = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (audioBase64 && outputAudioContextRef.current) {
            setIsModelSpeaking(true);
            const ctx = outputAudioContextRef.current;
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
            const buffer = await decodeAudioData(decode(audioBase64), ctx, SAMPLE_RATE_OUT, 1);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.onended = () => {
              sourcesRef.current.delete(source);
              if (sourcesRef.current.size === 0) setIsModelSpeaking(false);
            };
            source.start(nextStartTimeRef.current);
            nextStartTimeRef.current += buffer.duration;
            sourcesRef.current.add(source);
          }

          if (msg.toolCall) {
            for (const fc of msg.toolCall.functionCalls) {
              if (fc.name === 'updateWorkoutState') {
                const { action, value } = fc.args as any;
                if (action === 'set_difficulty') {
                  handleDifficultyChange(value as Difficulty);
                } else {
                  handleTrainerAction(action);
                }
                sessionPromise.then(s => s.sendToolResponse({
                  functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } }
                }));
              }
            }
          }

          if (msg.serverContent?.interrupted) {
            sourcesRef.current.forEach(s => s.stop());
            sourcesRef.current.clear();
            nextStartTimeRef.current = 0;
            setIsModelSpeaking(false);
          }
        },
        onerror: (e) => console.error(e),
        onclose: () => setIsWorkoutActive(false)
      }
    });

    sessionRef.current = await sessionPromise;
  };

  const handleTrainerAction = (action: string) => {
    setWorkoutState(prev => {
      const currentEx = activeExercises[prev.currentExerciseIndex];
      if (action === 'finish_set') {
        const isLastSet = prev.currentSet >= currentEx.targetSets;
        if (isLastSet) {
          const isLastEx = prev.currentExerciseIndex >= activeExercises.length - 1;
          if (isLastEx) {
            setTimeout(stopWorkout, 2000);
            return { ...prev, isActive: false };
          }
          return { ...prev, currentExerciseIndex: prev.currentExerciseIndex + 1, currentSet: 1, timer: 0, isResting: false };
        }
        startRestTimer(currentEx.restSeconds);
        return { ...prev, currentSet: prev.currentSet + 1, timer: currentEx.restSeconds, isResting: true };
      }
      return prev;
    });
  };

  const startRestTimer = (seconds: number) => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    let remaining = seconds;
    timerIntervalRef.current = window.setInterval(() => {
      remaining -= 1;
      setWorkoutState(prev => ({ ...prev, timer: remaining }));
      if (remaining <= 0) {
        clearInterval(timerIntervalRef.current!);
        setWorkoutState(prev => ({ ...prev, isResting: false }));
      }
    }, 1000);
  };

  return (
    <div className="min-h-screen max-w-lg mx-auto bg-black flex flex-col p-6 pb-12 overflow-x-hidden selection:bg-blue-500/30">
      {!profile ? (
        <Onboarding onComplete={setProfile} />
      ) : isWorkoutActive ? (
        <div className="flex flex-col h-full animate-in fade-in duration-1000">
           <header className="flex justify-between items-center mb-10 z-20">
            <button 
              onClick={stopWorkout}
              className="text-zinc-600 hover:text-white transition-colors flex items-center space-x-2 text-[10px] font-black uppercase tracking-widest"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
              <span>Exit Session</span>
            </button>
            <div className="flex items-center space-x-2 bg-zinc-900/50 px-3 py-1 rounded-full border border-zinc-800 backdrop-blur-md">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></div>
              <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400">Live AI Link</span>
            </div>
          </header>
          
          <WorkoutSessionView 
            state={workoutState} 
            exercises={activeExercises} 
            transcription={transcription}
            isModelSpeaking={isModelSpeaking}
            onDifficultyChange={handleDifficultyChange}
          />
        </div>
      ) : (
        <Dashboard user={profile} history={history} onStartWorkout={handleStartWorkout} />
      )}
      
      {/* Dynamic Background Effects */}
      <div className="fixed -bottom-48 -left-48 w-96 h-96 bg-blue-600/5 blur-[120px] pointer-events-none -z-10"></div>
      <div className="fixed -top-48 -right-48 w-96 h-96 bg-indigo-600/5 blur-[120px] pointer-events-none -z-10"></div>
    </div>
  );
};

export default App;
