"use client";
import React, { useState, useRef, useEffect } from 'react';
import { Camera, Shield, Lock, AlertTriangle, CheckCircle, Zap } from 'lucide-react';

const PPAHVerification = () => {
  const [step, setStep] = useState('idle'); // idle, webauthn, camera_check, capturing, monitoring, frozen, failed
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [anchorHash, setAnchorHash] = useState<string | null>(null);
  const [segmentCount, setSegmentCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('Ready to start verification');
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const monitoringRef = useRef<NodeJS.Timeout | null>(null);
  const previousHashRef = useRef<Uint8Array | null>(null);
  
  // NEW: Ref to trigger attack without restarting the interval loop
  const attackModeRef = useRef(false);

  // ---------------------------------------------------------------------------
  // 1. DYNAMIC API CONFIGURATION
  // ---------------------------------------------------------------------------
  const getBackendUrl = () => {
    if (typeof window === 'undefined') return 'http://localhost:8000';
    // Automatically points to localhost or your VM IP (172.x.x.x)
    return `http://${window.location.hostname}:8000`;
  };

  useEffect(() => {
    return () => {
      cleanupResources();
    };
  }, []);

  const cleanupResources = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (monitoringRef.current) {
      clearInterval(monitoringRef.current);
    }
  };

  const arrayBufferToHex = (buffer: ArrayBuffer) => {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  };

  const concatenateArrays = (arr1: Uint8Array, arr2: Uint8Array) => {
    const result = new Uint8Array(arr1.length + arr2.length);
    result.set(arr1, 0);
    result.set(arr2, arr1.length);
    return result;
  };

  // ---------------------------------------------------------------------------
  // STEP 1: WebAuthn (Flexible ID for VM support)
  // ---------------------------------------------------------------------------
  const performWebAuthn = async () => {
    setStep('webauthn');
    setStatusMessage('Authenticating with passkey...');
    
    try {
      if (!window.PublicKeyCredential) {
        throw new Error('WebAuthn not supported in this browser');
      }

      const backendUrl = getBackendUrl();
      const challenge = new Uint8Array(32);
      crypto.getRandomValues(challenge);

      try {
        // Attempt Authentication (Browser auto-detects RP ID)
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: challenge,
            timeout: 60000,
            userVerification: 'required'
          }
        });
        
        if (assertion) {
          setStatusMessage('Authentication successful!');
          return true;
        }
      } catch (getError) {
        console.log('Creating new credential...');
        
        const userId = new Uint8Array(16);
        crypto.getRandomValues(userId);
        
        // Attempt Registration (Browser auto-detects RP ID)
        const credential = await navigator.credentials.create({
          publicKey: {
            challenge: challenge,
            rp: { name: "PPAH Verification" },
            user: {
              id: userId,
              name: "demo@ppah.app",
              displayName: "Demo User"
            },
            pubKeyCredParams: [
              { alg: -7, type: "public-key" },
              { alg: -257, type: "public-key" }
            ],
            authenticatorSelection: {
              authenticatorAttachment: "platform",
              userVerification: "required",
              residentKey: "preferred"
            },
            timeout: 60000,
            attestation: "none"
          }
        });

        if (credential) {
          await fetch(`${backendUrl}/api/webauthn/register`, {
             method: 'POST',
             headers: {'Content-Type': 'application/json'},
             body: JSON.stringify({
                 credential_id: credential.id,
                 email: "demo@ppah.app"
             })
          });
          setStatusMessage('Passkey created & registered!');
          return true;
        }
      }
    } catch (err: any) {
      console.error('WebAuthn error:', err);
      // Allow demo to proceed even if WebAuthn fails (for testing ease)
      setError(`Auth Warning: ${err.message}. Proceeding for demo...`);
      await new Promise(r => setTimeout(r, 1500));
      return true; 
    }
    return false;
  };

  // ---------------------------------------------------------------------------
  // STEP 2: Camera & Virtual Cam Check
  // ---------------------------------------------------------------------------
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
            videoRef.current.onloadedmetadata = () => {
              videoRef.current?.play();
              resolve();
            };
          }
        });
      }

      const track = stream.getVideoTracks()[0];
      const label = track.label.toLowerCase();
      const virtualIndicators = ['obs', 'virtual', 'manycam', 'snap', 'xsplit', 'loopback', 'fake'];
      
      if (virtualIndicators.some(i => label.includes(i))) {
        setError('Virtual camera detected! Please use a physical camera.');
        track.stop();
        setStep('failed');
        return false;
      }

      setStatusMessage('Physical camera verified ✓');
      return true;

    } catch (err: any) {
      console.error('Camera error:', err);
      setError(`Camera access failed: ${err.message}`);
      setStep('failed');
      return false;
    }
  };

  // ---------------------------------------------------------------------------
  // STEP 3: Hashing Logic
  // ---------------------------------------------------------------------------
  const captureAndHashFrames = async (numFrames = 10) => {
    const hashes: Uint8Array[] = [];
    const canvas = canvasRef.current;
    const video = videoRef.current;
    
    if (!canvas || !video) return [];
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    for (let i = 0; i < numFrames; i++) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hashBuffer = await crypto.subtle.digest('SHA-256', imageData.data);
      hashes.push(new Uint8Array(hashBuffer));
      await new Promise(r => setTimeout(r, 100)); 
    }
    return hashes;
  };

  // ---------------------------------------------------------------------------
  // STEP 4: Anchor Creation
  // ---------------------------------------------------------------------------
  const createAnchorHash = async () => {
    setStep('capturing');
    setStatusMessage('Creating secure baseline...');

    try {
      const frameHashes = await captureAndHashFrames(10);
      if (frameHashes.length === 0) throw new Error("No frames captured");

      let combined = frameHashes[0];
      for (let i = 1; i < frameHashes.length; i++) {
        combined = concatenateArrays(combined, frameHashes[i]);
      }

      const anchorBuffer = await crypto.subtle.digest('SHA-256', combined);
      const anchorHex = arrayBufferToHex(anchorBuffer);

      setAnchorHash(anchorHex);
      previousHashRef.current = new Uint8Array(anchorBuffer);
      
      const backendUrl = getBackendUrl();
      const initRes = await fetch(`${backendUrl}/api/session/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: "demo@ppah.app" })
      });
      const initData = await initRes.json();
      setSessionId(initData.session_id);

      setStatusMessage('Baseline established. Monitoring active.');
      setStep('monitoring');
      startMonitoring(initData.session_id);

    } catch (err: any) {
      console.error('Anchor error:', err);
      setError('Failed to create baseline: ' + err.message);
      setStep('failed');
    }
  };

  // ---------------------------------------------------------------------------
  // STEP 5: Monitoring Loop (With Attack Simulation)
  // ---------------------------------------------------------------------------
  const startMonitoring = (activeSessionId: string) => {
    let segmentCounter = 1;
    attackModeRef.current = false; // Reset attack flag

    monitoringRef.current = setInterval(async () => {
      try {
        if (!previousHashRef.current) return;

        // 1. Capture frames
        const frameHashes = await captureAndHashFrames(5);
        if (frameHashes.length === 0) return;

        // 2. Chain hashes
        let combined = frameHashes[0];
        for (let i = 1; i < frameHashes.length; i++) {
          combined = concatenateArrays(combined, frameHashes[i]);
        }
        const chainedData = concatenateArrays(combined, previousHashRef.current);
        const currentHashBuffer = await crypto.subtle.digest('SHA-256', chainedData);
        const currentHashHex = arrayBufferToHex(currentHashBuffer);

        // --- ATTACK LOGIC START ---
        // If attack triggered, we send a JUMP in segment ID to break the chain sequence
        const isAttack = attackModeRef.current;
        const segmentToSend = isAttack ? segmentCounter + 100 : segmentCounter; 
        // --- ATTACK LOGIC END ---

        // 3. Send to Server
        const backendUrl = getBackendUrl();
        const response = await fetch(`${backendUrl}/api/verify-hash`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: activeSessionId,
            segment_id: segmentToSend, // Sends wrong ID if attack is active
            hash: currentHashHex
          })
        }).catch((e) => {
            console.warn("Backend unavailable:", e);
            return null; 
        });

        // 4. Validate Response
        if (response && response.ok) {
          const data = await response.json();
          
          if (!data.valid) {
            // The backend rejected our "Attack" segment -> Detection Successful!
            handleHashMismatch(); 
            return;
          }
          
          // Continue if valid
          previousHashRef.current = new Uint8Array(currentHashBuffer);
          setSegmentCount(segmentCounter);
          segmentCounter++;
        }

      } catch (err) {
        console.error('Monitoring error:', err);
      }
    }, 2000);
  };

  const handleHashMismatch = () => {
    cleanupResources();
    setStep('frozen');
    setStatusMessage('⚠️ SECURITY ALERT: Deepfake detected!');
    setError('Chain integrity broken. The server rejected the video sequence.');
  };

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  const startVerification = async () => {
    setError(null);
    attackModeRef.current = false;
    
    const authSuccess = await performWebAuthn();
    if (!authSuccess) return;
    
    await new Promise(r => setTimeout(r, 500));
    const cameraSuccess = await initializeCamera();
    if (!cameraSuccess) return;

    await new Promise(r => setTimeout(r, 500));
    await createAnchorHash();
  };

  const stopVerification = () => {
    cleanupResources();
    setStep('idle');
    setStatusMessage('Ready to start verification');
    setSessionId(null);
    setAnchorHash(null);
    setSegmentCount(0);
    attackModeRef.current = false;
  };

  const triggerAttack = () => {
    attackModeRef.current = true;
    setStatusMessage('INJECTING FAKE FRAMES...');
  };

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 p-8 font-sans">
      <div className="max-w-4xl mx-auto bg-slate-800 rounded-2xl shadow-2xl overflow-hidden border border-slate-700">
        
        {/* Header */}
        <div className="bg-slate-950 p-6 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <Shield className="w-8 h-8 text-blue-500" />
            <h1 className="text-2xl font-bold text-white">PPAH 2.0 Verification</h1>
          </div>
          <p className="mt-1 text-slate-400 text-sm">
            Privacy-Preserving Adaptive Hashing
          </p>
        </div>

        {/* Video Display */}
        <div className="relative bg-black h-[400px] flex items-center justify-center">
          <video
            ref={videoRef}
            autoPlay muted playsInline
            className="w-full h-full object-cover"
          />
          
          <div className="absolute top-4 left-4 right-4 flex justify-between items-start">
             <div className={`backdrop-blur px-4 py-2 rounded-full text-white text-sm flex items-center gap-2 border border-white/10 ${step === 'frozen' ? 'bg-red-600/80' : 'bg-black/60'}`}>
                {step === 'monitoring' ? <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" /> : <Lock size={14} />}
                {statusMessage}
             </div>
             {sessionId && (
                 <div className="bg-black/60 backdrop-blur px-3 py-1 rounded text-xs text-slate-400 font-mono border border-white/10">
                     ID: {sessionId.substring(0, 8)}
                 </div>
             )}
          </div>
        </div>

        <canvas ref={canvasRef} className="hidden" />

        {/* Controls */}
        <div className="p-6 space-y-6">
          
          {error && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-200 p-4 rounded-lg flex items-center gap-3">
              <AlertTriangle className="flex-shrink-0 text-red-500" />
              <div>
                <p className="font-bold text-red-400">Security Alert</p>
                <p className="text-sm">{error}</p>
              </div>
            </div>
          )}

          <div className="flex gap-4">
             {step === 'idle' || step === 'failed' || step === 'frozen' ? (
                <button onClick={startVerification} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 rounded-lg transition-all flex items-center justify-center gap-2">
                   <Shield size={20} /> Initialize Secure Session
                </button>
             ) : (
                <>
                  <button onClick={stopVerification} className="flex-1 bg-slate-600 hover:bg-slate-500 text-white font-bold py-4 rounded-lg transition-all">
                     Terminate Session
                  </button>
                  
                  {/* NEW ATTACK BUTTON */}
                  <button onClick={triggerAttack} className="flex-1 bg-orange-600 hover:bg-orange-500 text-white font-bold py-4 rounded-lg transition-all flex items-center justify-center gap-2 animate-in fade-in">
                     <Zap size={20} /> Simulate Deepfake Injection
                  </button>
                </>
             )}
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="bg-slate-700/50 p-4 rounded-lg border border-slate-600">
               <div className="text-slate-400 text-xs uppercase tracking-wider mb-1">Segments Verified</div>
               <div className="text-2xl font-mono text-blue-400 font-bold">{segmentCount}</div>
            </div>
            <div className="bg-slate-700/50 p-4 rounded-lg border border-slate-600">
               <div className="text-slate-400 text-xs uppercase tracking-wider mb-1">Camera Source</div>
               <div className="flex items-center gap-2 text-sm font-semibold">
                  <Camera size={16} /> 
                  {step === 'idle' ? 'Waiting...' : 'Physical Feed'}
               </div>
            </div>
            <div className="bg-slate-700/50 p-4 rounded-lg border border-slate-600">
               <div className="text-slate-400 text-xs uppercase tracking-wider mb-1">System Status</div>
               <div className={`text-sm font-bold flex items-center gap-2 ${step === 'monitoring' ? 'text-green-400' : step === 'frozen' ? 'text-red-400' : 'text-slate-400'}`}>
                  {step === 'monitoring' ? <CheckCircle size={16} /> : step === 'frozen' ? <AlertTriangle size={16} /> : <div className="w-4 h-4 rounded-full border-2 border-slate-500" />}
                  {step === 'monitoring' ? 'SECURE' : step === 'frozen' ? 'COMPROMISED' : 'STANDBY'}
               </div>
            </div>
          </div>
          
        </div>
      </div>
    </div>
  );
};

export default PPAHVerification;
