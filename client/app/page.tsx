"use client";
import React, { useState, useRef, useEffect } from 'react';
import { Camera, Shield, Lock, AlertTriangle, CheckCircle, Zap, Eye, User, Activity } from 'lucide-react';

const PPAHVerification = () => {
  // --- STATE ---
  const [step, setStep] = useState('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [anchorHash, setAnchorHash] = useState<string | null>(null);
  const [segmentCount, setSegmentCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('Ready to start verification');
  const [biometricLocked, setBiometricLocked] = useState(false);
  
  // Adaptive Trust Score
  const [trustScore, setTrustScore] = useState(100);

  // --- REFS ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const monitoringRef = useRef<NodeJS.Timeout | null>(null);
  const previousHashRef = useRef<Uint8Array | null>(null);
  const attackModeRef = useRef(false);
  
  // Security Refs
  const sessionKeyRef = useRef<string | null>(null);
  const anchorBiometricRef = useRef<any | null>(null);
  const cameraFingerprintRef = useRef<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  
  // Logic Refs (Avoid Stale State in Loops)
  const stepRef = useRef(step); 
  const challengeActiveRef = useRef(false);
  const previousFramesRef = useRef<ImageData[]>([]);
  const biometricFailuresRef = useRef(0);

  // Sync Step Ref
  useEffect(() => { stepRef.current = step; }, [step]);

  // --- CONFIG ---
  const getBackendUrl = () => {
    if (typeof window === 'undefined') return 'http://localhost:8000';
    return `http://${window.location.hostname}:8000`;
  };

  // --- WORKER INITIALIZATION ---
  useEffect(() => {
    workerRef.current = new Worker('/biometric-worker.js');
    
    workerRef.current.onmessage = (e) => {
      const { type, liveness, similarity, fingerprint } = e.data;

      if (type === 'ANALYSIS_RESULT') {
        // 1. Liveness Check
        if (typeof liveness === 'number') {
          setLivenessScore(Math.round(liveness));
        }

        // 2. Biometric Check (With Guard Clause)
        if (typeof similarity === 'number' && anchorBiometricRef.current) {
          
          if (similarity < 0.60) {
            handleBiometricMismatchSmart(similarity);
          } else {
            // HEALING LOGIC: Slowly recover trust if user is valid
            setTrustScore(prev => Math.min(100, prev + 5)); 
            biometricFailuresRef.current = 0; 
            
            // Only update text if we are strictly monitoring
            if (!challengeActiveRef.current && stepRef.current === 'monitoring') {
                setStatusMessage('System Secure - Monitoring');
            }
          }
        }
      }
      else if (type === 'ANCHOR_GENERATED') {
        anchorBiometricRef.current = fingerprint;
        setBiometricLocked(true);
        console.log('[BIOMETRIC] Anchor created via Worker');
      }
      else if (type === 'ANCHOR_UPDATED') {
        // Rolling Update: Adapt to lighting changes
        anchorBiometricRef.current = fingerprint;
        console.log('[ADAPTIVE] Anchor evolved for lighting drift');
      }
    };

    return () => {
      cleanupResources();
      workerRef.current?.terminate();
    };
  }, []); // <--- EMPTY DEPENDENCY: Prevents Camera from Stopping

  const cleanupResources = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (monitoringRef.current) {
      clearInterval(monitoringRef.current);
    }
  };

  // --- UTILS ---
  const arrayBufferToHex = (buffer: ArrayBuffer) => {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const concatenateArrays = (arr1: Uint8Array, arr2: Uint8Array) => {
    const result = new Uint8Array(arr1.length + arr2.length);
    result.set(arr1, 0);
    result.set(arr2, arr1.length);
    return result;
  };

  // --- HMAC SIGNING ---
  const signPacket = async (sessionId: string, segmentId: number, hash: string) => {
    if (!sessionKeyRef.current) return "unsigned"; 
    
    const encoder = new TextEncoder();
    const keyData = encoder.encode(sessionKeyRef.current);
    const message = encoder.encode(`${sessionId}${segmentId}${hash}`);
    
    try {
      const key = await crypto.subtle.importKey(
        "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
      const signature = await crypto.subtle.sign("HMAC", key, message);
      return arrayBufferToHex(signature);
    } catch (e) {
      console.error("Signing failed:", e);
      return "error";
    }
  };

  // --- TRUST LOGIC ---
  const [livenessScore, setLivenessScore] = useState(0);
  const [challengeActive, setChallengeActive] = useState(false);
  const [currentChallenge, setCurrentChallenge] = useState<string | null>(null);

  const handleBiometricMismatchSmart = async (similarity: number) => {
    biometricFailuresRef.current++;
    const penalty = similarity < 0.40 ? 20 : 5;

    setTrustScore(prev => {
        const newScore = Math.max(0, prev - penalty);
        if (newScore === 0) {
           handleBiometricMismatch(similarity);
           return 0;
        } 
        if (newScore < 60) {
           setStatusMessage('⚠️ Analysing identity... Please hold still');
           if (!challengeActiveRef.current) {
               triggerLivenessChallenge();
           }
        }
        return newScore;
    });
  };

  const challenges = ["Turn head left", "Turn head right", "Smile", "Blink twice"];
  const triggerLivenessChallenge = async () => {
    if (challengeActiveRef.current) return;
    const challenge = challenges[Math.floor(Math.random() * challenges.length)];
    
    setCurrentChallenge(challenge);
    setChallengeActive(true);
    challengeActiveRef.current = true;
    
    await new Promise(r => setTimeout(r, 4000));
    
    setChallengeActive(false);
    setCurrentChallenge(null);
    challengeActiveRef.current = false;
  };

  const getCameraFingerprint = (stream: MediaStream): string => {
    const videoTrack = stream.getVideoTracks()[0];
    const settings = videoTrack.getSettings();
    return JSON.stringify({
      deviceId: settings.deviceId || 'unknown',
      label: videoTrack.label,
      width: settings.width,
      frameRate: settings.frameRate
    });
  };

  // --- WEBAUTHN & CAMERA ---
  const performWebAuthn = async () => {
    setStep('webauthn');
    setStatusMessage('Authenticating with passkey...');
    try {
      if (!window.PublicKeyCredential) throw new Error('WebAuthn not supported');
      const backendUrl = getBackendUrl();
      // Demo Mode: We proceed even if WebAuthn fails (for testing ease)
      return true; 
    } catch (err) {
      return true; 
    }
  };

  const initializeCamera = async () => {
    setStep('camera_check');
    setStatusMessage('Checking camera...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await new Promise<void>((resolve) => {
          if (videoRef.current) {
            videoRef.current.onloadedmetadata = () => { videoRef.current?.play(); resolve(); };
          }
        });
      }
      const track = stream.getVideoTracks()[0];
      const label = track.label.toLowerCase();
      if (['obs', 'virtual', 'fake'].some(i => label.includes(i))) {
        setError('Virtual camera detected!');
        track.stop();
        setStep('failed');
        return false;
      }
      cameraFingerprintRef.current = getCameraFingerprint(stream);
      setStatusMessage('Physical camera verified ✓');
      return true;
    } catch (err: any) {
      setError(`Camera access failed: ${err.message}`);
      setStep('failed');
      return false;
    }
  };

  // --- CORE LOOP ---
  const captureAndHashFrames = async (numFrames = 10) => {
    const hashes: Uint8Array[] = [];
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return [];
    
    // Performance Optimization
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    for (let i = 0; i < numFrames; i++) {
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hashBuffer = await crypto.subtle.digest('SHA-256', imageData.data);
      hashes.push(new Uint8Array(hashBuffer));
      await new Promise(r => setTimeout(r, 50)); 
    }
    return hashes;
  };

  const createAnchorHash = async () => {
    setStep('capturing');
    setStatusMessage('Creating secure baseline...');
    try {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) throw new Error("No video");
      
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error("No context");

      // 1. Capture Hash Chain Anchor
      const frameHashes = await captureAndHashFrames(10);
      if (frameHashes.length === 0) throw new Error("No frames");
      let combined = frameHashes[0];
      for (let i = 1; i < frameHashes.length; i++) combined = concatenateArrays(combined, frameHashes[i]);
      const anchorBuffer = await crypto.subtle.digest('SHA-256', combined);
      
      setAnchorHash(arrayBufferToHex(anchorBuffer));
      previousHashRef.current = new Uint8Array(anchorBuffer);

      // 2. Generate Biometric Anchor (Worker)
      ctx.drawImage(video, 0, 0);
      const anchorImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      
      workerRef.current?.postMessage({
        type: 'GENERATE_ANCHOR',
        imageData: anchorImageData
      });

      // 3. Initialize Session
      const backendUrl = getBackendUrl();
      const initRes = await fetch(`${backendUrl}/api/session/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            email: "demo@ppah.app", 
            camera_fingerprint: cameraFingerprintRef.current 
          })
      });
      const initData = await initRes.json();
      setSessionId(initData.session_id);
      
      if (initData.session_key) {
        sessionKeyRef.current = initData.session_key;
        console.log("Session Key Exchange Complete");
      }

      setStatusMessage('Baseline Established');
      setStep('monitoring');
      setTrustScore(100);
      startMonitoring(initData.session_id);

    } catch (err: any) {
      console.error(err);
      setError('Failed to create baseline');
      setStep('failed');
    }
  };

  const startMonitoring = (activeSessionId: string) => {
    let segmentCounter = 1;
    attackModeRef.current = false;

    monitoringRef.current = setInterval(async () => {
      try {
        if (!previousHashRef.current || !videoRef.current || !canvasRef.current) return;
        
        // 1. Capture Hash
        const frameHashes = await captureAndHashFrames(5);
        if (frameHashes.length === 0) return;

        // 2. Worker Biometrics
        const ctx = canvasRef.current.getContext('2d', { willReadFrequently: true });
        if (ctx) {
            ctx.drawImage(videoRef.current, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height);
            
            previousFramesRef.current.push(imageData);
            if (previousFramesRef.current.length > 5) previousFramesRef.current.shift();

            workerRef.current?.postMessage({
                type: 'ANALYZE_FRAME',
                imageData: imageData,
                previousFrames: previousFramesRef.current, 
                anchorBiometric: anchorBiometricRef.current
            });
        }

        // 3. Chain Hash
        let combined = frameHashes[0];
        for (let i = 1; i < frameHashes.length; i++) combined = concatenateArrays(combined, frameHashes[i]);
        const chainedData = concatenateArrays(combined, previousHashRef.current);
        const currentHashBuffer = await crypto.subtle.digest('SHA-256', chainedData);
        const currentHashHex = arrayBufferToHex(currentHashBuffer);

        // 4. Sign Packet
        const isAttack = attackModeRef.current;
        const segmentToSend = isAttack ? segmentCounter + 100 : segmentCounter;
        const signature = await signPacket(activeSessionId, segmentToSend, currentHashHex);

        // 5. Send to Server
        const backendUrl = getBackendUrl();
        const response = await fetch(`${backendUrl}/api/verify-hash`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: activeSessionId,
            segment_id: segmentToSend,
            hash: currentHashHex,
            signature: signature 
          })
        }).catch(e => null);

        if (response && response.ok) {
          const data = await response.json();
          if (!data.valid) {
            handleHashMismatch();
          } else {
            previousHashRef.current = new Uint8Array(currentHashBuffer);
            setSegmentCount(segmentCounter);
            segmentCounter++;
          }
        }
      } catch (err) {
        console.error('Monitoring error:', err);
      }
    }, 2000);
  };

  const handleHashMismatch = () => {
    cleanupResources();
    setStep('frozen');
    setStatusMessage('⚠️ SECURITY ALERT: Integrity Broken');
    setError('Hash chain validation failed. Server rejected packet.');
  };

  const handleBiometricMismatch = (similarity: number) => {
    cleanupResources();
    setStep('frozen');
    setStatusMessage('⚠️ SECURITY ALERT: Biometric Mismatch');
    setError(`Person changed! Trust score depleted.`);
  };

  const startVerification = async () => {
    setError(null);
    attackModeRef.current = false;
    setBiometricLocked(false);
    await performWebAuthn(); 
    await new Promise(r => setTimeout(r, 500));
    const cam = await initializeCamera();
    if (cam) {
        await new Promise(r => setTimeout(r, 500));
        await createAnchorHash();
    }
  };

  const stopVerification = () => {
    cleanupResources();
    setStep('idle');
    setStatusMessage('Ready');
    setSessionId(null);
    setSegmentCount(0);
    setTrustScore(100);
    setBiometricLocked(false);
    sessionKeyRef.current = null; 
  };

  const triggerAttack = () => {
    attackModeRef.current = true;
    setStatusMessage('INJECTING FAKE FRAMES...');
  };

  // --- RENDER ---
  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 p-8 font-sans">
      <div className="max-w-4xl mx-auto bg-slate-800 rounded-2xl shadow-2xl overflow-hidden border border-slate-700">
        <div className="bg-slate-950 p-6 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <Shield className="w-8 h-8 text-blue-500" />
            <div>
              <h1 className="text-2xl font-bold text-white">PPAH 3.0 Enterprise</h1>
              <p className="text-xs text-slate-400 mt-1">Multi-Modal: Hash Chain + Biometric Lock + Packet Signing</p>
            </div>
          </div>
        </div>

        <div className="relative bg-black h-[400px] flex items-center justify-center">
          <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
          
          {/* Overlays */}
          <div className="absolute top-4 left-4 right-4 flex justify-between items-start">
             <div className={`backdrop-blur px-4 py-2 rounded-full text-white text-sm flex items-center gap-2 border border-white/10 ${step === 'frozen' ? 'bg-red-600/80' : 'bg-black/60'}`}>
                {step === 'monitoring' ? <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" /> : <Lock size={14} />}
                {statusMessage}
             </div>
             {sessionId && <div className="bg-black/60 backdrop-blur px-3 py-1 rounded text-xs text-slate-400 font-mono border border-white/10">ID: {sessionId.substring(0, 8)}</div>}
          </div>

          {/* Liveness Challenge */}
          {challengeActive && currentChallenge && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur z-20">
              <div className="bg-blue-600/90 p-8 rounded-2xl shadow-2xl text-center animate-pulse border border-blue-400">
                <div className="text-4xl mb-4">👤</div>
                <div className="text-2xl font-bold text-white mb-2">Liveness Check</div>
                <div className="text-xl text-white">{currentChallenge}</div>
              </div>
            </div>
          )}

          {/* Liveness Score */}
          {livenessScore > 0 && step === 'monitoring' && (
            <div className="absolute bottom-4 right-4 bg-black/70 backdrop-blur px-3 py-2 rounded-lg text-xs">
              <div className="text-slate-400 mb-1">Liveness</div>
              <div className="flex items-center gap-2">
                <div className="w-24 h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div className={`h-full transition-all ${livenessScore > 70 ? 'bg-green-500' : 'bg-yellow-500'}`} style={{ width: `${livenessScore}%` }} />
                </div>
                <span className="font-mono font-bold text-white">{livenessScore}</span>
              </div>
            </div>
          )}

          {/* Trust Score */}
          {step === 'monitoring' && (
            <div className="absolute bottom-4 left-4 bg-black/70 backdrop-blur px-3 py-2 rounded-lg text-xs">
              <div className="text-slate-400 mb-1">Identity Trust</div>
              <div className="flex items-center gap-2">
                <div className="w-24 h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div className={`h-full transition-all duration-500 ${trustScore > 60 ? 'bg-blue-500' : trustScore > 20 ? 'bg-orange-500' : 'bg-red-500'}`} style={{ width: `${trustScore}%` }} />
                </div>
                <span className="font-mono font-bold text-white">{trustScore}%</span>
              </div>
            </div>
          )}
        </div>

        <canvas ref={canvasRef} className="hidden" />

        <div className="p-6 space-y-6">
          {error && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-200 p-4 rounded-lg flex items-center gap-3">
              <AlertTriangle className="flex-shrink-0 text-red-500" />
              <div><p className="font-bold text-red-400">Security Alert</p><p className="text-sm">{error}</p></div>
            </div>
          )}

          <div className="flex gap-4">
             {step === 'idle' || step === 'failed' || step === 'frozen' ? (
                <button onClick={startVerification} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 rounded-lg flex items-center justify-center gap-2">
                   <Shield size={20} /> Initialize Secure Session
                </button>
             ) : (
                <>
                  <button onClick={stopVerification} className="flex-1 bg-slate-600 hover:bg-slate-500 text-white font-bold py-4 rounded-lg">Terminate</button>
                  <button onClick={triggerAttack} className="flex-1 bg-orange-600 hover:bg-orange-500 text-white font-bold py-4 rounded-lg flex items-center justify-center gap-2">
                     <Zap size={20} /> Simulate Attack
                  </button>
                </>
             )}
          </div>

          <div className="grid grid-cols-4 gap-4 text-center">
            <div className="bg-slate-700/50 p-3 rounded border border-slate-600">
               <div className="text-slate-400 text-[10px] uppercase">Segments</div>
               <div className="text-xl font-mono text-blue-400 font-bold">{segmentCount}</div>
            </div>
            <div className="bg-slate-700/50 p-3 rounded border border-slate-600">
               <div className="text-slate-400 text-[10px] uppercase">Biometric</div>
               <div className={`text-sm font-bold ${biometricLocked ? 'text-green-400' : 'text-slate-400'}`}>{biometricLocked ? 'LOCKED' : '-'}</div>
            </div>
            <div className="bg-slate-700/50 p-3 rounded border border-slate-600">
               <div className="text-slate-400 text-[10px] uppercase">Encryption</div>
               <div className={`text-sm font-bold ${sessionKeyRef.current ? 'text-green-400' : 'text-slate-400'}`}>{sessionKeyRef.current ? 'HMAC-256' : 'NONE'}</div>
            </div>
            <div className="bg-slate-700/50 p-3 rounded border border-slate-600">
               <div className="text-slate-400 text-[10px] uppercase">Status</div>
               <div className={`text-sm font-bold ${step === 'monitoring' ? 'text-green-400' : step === 'frozen' ? 'text-red-400' : 'text-slate-400'}`}>
                  {step === 'monitoring' ? 'SECURE' : step === 'frozen' ? 'BREACH' : 'IDLE'}
               </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PPAHVerification;
