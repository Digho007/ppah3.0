"use client";
import React, { useState, useRef, useEffect } from 'react';
import { Shield, Phone, PhoneOff, UserX, Fingerprint, PlusCircle, Move, Signal, RefreshCw, AlertCircle } from 'lucide-react';
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

// --- 1. ERROR SUPPRESSION ---
if (typeof window !== 'undefined') {
  const originalError = console.error;
  const originalInfo = console.info;

  console.error = (...args) => {
    if (/NotAllowedError/.test(args[0]?.toString())) return;
    if (/Created TensorFlow Lite XNNPACK delegate for CPU/.test(args[0]?.toString())) return;
    originalError.call(console, ...args);
  };

  console.info = (...args) => {
    if (/Created TensorFlow Lite XNNPACK delegate for CPU/.test(args[0]?.toString())) return;
    originalInfo.call(console, ...args);
  };
}

const PPAHVerification = () => {
  // --- STATE ---
  const [step, setStep] = useState('idle');
  const [userEmail, setUserEmail] = useState("user@example.com");
  const [sessionId, setSessionId] = useState<string | null>(null);
  
  // ROOM STATE
  const [roomId, setRoomId] = useState('');
  const [tempRoomId, setTempRoomId] = useState('');
  
  // DIAGNOSTICS & STATUS
  const [statusMessage, setStatusMessage] = useState('Ready');
  const [iceStatus, setIceStatus] = useState('New'); // New, Checking, Connected, Failed
  const [trustScore, setTrustScore] = useState(100);
  const [remoteTrustScore, setRemoteTrustScore] = useState<number | null>(null);
  const [remoteSessionId, setRemoteSessionId] = useState<string | null>(null);
  const [inCall, setInCall] = useState(false);
  
  // UI State
  const [faceDetected, setFaceDetected] = useState(true);
  const [challengeActive, setChallengeActive] = useState(false);
  const [currentChallenge, setCurrentChallenge] = useState<string | null>(null);
  
  // DRAGGABLE PIP STATE
  const [pipPosition, setPipPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // --- REFS ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  
  // Security Refs
  const sessionKeyRef = useRef<string | null>(null);
  const webAuthnCredRef = useRef<string | null>(null);
  const anchorBiometricRef = useRef<any | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const monitoringRef = useRef<NodeJS.Timeout | null>(null);
  const trustScoreRef = useRef(trustScore); 
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const challengeActiveRef = useRef(false);
  
  // Debounce Counters
  const noFaceCounter = useRef(0);
  const lowBioCounter = useRef(0);
  const lastSuccessTimeRef = useRef<number>(0);

  useEffect(() => { trustScoreRef.current = trustScore; }, [trustScore]);

  // --- HELPER: JOIN ROOM ---
  const joinRoom = () => {
      const cleanId = tempRoomId.trim().toLowerCase();
      if(cleanId) setRoomId(cleanId);
  };

  const getBackendUrl = () => ""; 
  const getWsUrl = () => {
    if (typeof window !== 'undefined') {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/ws/${roomId}`;
    }
    return '';
  };

  // --- 2. INITIALIZE ---
  useEffect(() => {
    const loadModel = async () => {
        try {
            const filesetResolver = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm");
            landmarkerRef.current = await FaceLandmarker.createFromOptions(filesetResolver, {
                baseOptions: {
                    modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                    delegate: "GPU"
                },
                runningMode: "VIDEO",
                numFaces: 1
            });
        } catch (e) { console.warn("MediaPipe Load Error", e); }
    };
    loadModel();

    workerRef.current = new Worker('/biometric-worker.js');
    workerRef.current.onmessage = (e) => {
      const { type, similarity, fingerprint } = e.data;
      if (type === 'ANALYSIS_RESULT') {
        if (challengeActiveRef.current) return;
        if (typeof similarity === 'number' && anchorBiometricRef.current) {
          if (similarity < 0.45) {
             lowBioCounter.current += 1;
             if (lowBioCounter.current > 3) handleSecurityEvent("Identity Mismatch", 10);
          } else { lowBioCounter.current = 0; }
        }
      } else if (type === 'ANCHOR_GENERATED') {
        anchorBiometricRef.current = fingerprint;
      }
    };
    return () => cleanup();
  }, []);

  const handleSecurityEvent = (reason: string, penalty: number) => {
      if (challengeActiveRef.current) return;
      if (Date.now() - lastSuccessTimeRef.current < 10000) {
          setTrustScore(prev => Math.min(100, prev + 2)); 
          setStatusMessage("Verifying... (Secure)");
          return;
      }
      setTrustScore(prev => {
          const newScore = Math.max(0, prev - penalty);
          if (newScore < 40 && !challengeActiveRef.current) triggerLivenessChallenge();
          return newScore;
      });
      setStatusMessage(`⚠️ ${reason}`);
  };

  const cleanup = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    if (socketRef.current) socketRef.current.close();
    if (peerConnection.current) peerConnection.current.close();
    if (monitoringRef.current) clearInterval(monitoringRef.current);
  };

  // --- 3. WEBAUTHN ---
  const registerSecurityKey = async () => {
    try {
        setStatusMessage("Registering Key...");
        const resp = await fetch(`${getBackendUrl()}/api/webauthn/register/options`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ email: userEmail })
        });
        const options = await resp.json();
        const attResp = await startRegistration(options);
        const verifyResp = await fetch(`${getBackendUrl()}/api/webauthn/register/verify`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ email: userEmail, response: attResp })
        });
        if (verifyResp.ok) setStatusMessage("Key Registered Successfully! ✅");
        else setStatusMessage("Registration Failed ❌");
    } catch (error: any) {
        setStatusMessage(error.name === 'NotAllowedError' ? "Registration Cancelled" : "Registration Error");
    }
  };

  const performWebAuthnLogin = async () => {
    setStep('webauthn');
    setStatusMessage('Please Touch Your Security Key...');
    try {
        const resp = await fetch(`${getBackendUrl()}/api/webauthn/login/options`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ email: userEmail })
        });
        if (!resp.ok) {
            setStatusMessage("User not found. Register first!");
            setTimeout(() => setStep('idle'), 2000);
            return false;
        }
        const options = await resp.json();
        const authResp = await startAuthentication(options);
        const verifyResp = await fetch(`${getBackendUrl()}/api/webauthn/login/verify`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ email: userEmail, response: authResp })
        });
        const verificationJSON = await verifyResp.json();
        if (verificationJSON.verified) {
            webAuthnCredRef.current = verificationJSON.credential_id;
            setStatusMessage('Hardware Key Verified ✓');
            return true;
        }
    } catch (error: any) {
        if (error.name === 'NotAllowedError') {
            setStatusMessage("Login Cancelled");
            setTimeout(() => setStep('idle'), 1500);
        } else {
            setStatusMessage('Hardware Auth Failed');
        }
    }
    return false;
  };

  // --- 4. SIGNALING & CONNECTIVITY (EXPRESSTURN ENABLED) ---
  const restartIce = () => {
     if(socketRef.current && peerConnection.current) {
         socketRef.current.close();
         peerConnection.current.close();
         setIceStatus('Restarting...');
         setTimeout(() => startCall(sessionId!), 1000);
     }
  };

  const startCall = async (activeSessionId: string) => {
    if (!streamRef.current) return;
    setInCall(true);
    setIceStatus('Connecting...');
    
    // --- UPDATED ICE SERVERS (With ExpressTURN) ---
    const pc = new RTCPeerConnection({ 
        iceServers: [
            // 1. Google STUN (Backup)
            { urls: 'stun:stun.l.google.com:19302' },
            
            // 2. ExpressTURN (Port 3480 as requested)
            {
                urls: "turn:relay1.expressturn.com:3480", 
                username: "000000002081401268", 
                credential: "cTgF/eRaT2gKMgz80O1wl1DbNCo=" 
            },
            // 3. ExpressTURN (Port 443 Fallback for strict firewalls)
            {
                urls: "turn:relay1.expressturn.com:443", 
                username: "000000002081401268", 
                credential: "cTgF/eRaT2gKMgz80O1wl1DbNCo=" 
            }
        ] 
    });
    
    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log("ICE State:", state);
        setIceStatus(state.charAt(0).toUpperCase() + state.slice(1));
        if (state === 'failed' || state === 'disconnected') {
            setStatusMessage("Connection Lost. Try Retrying.");
        }
    };

    streamRef.current.getTracks().forEach(track => pc.addTrack(track, streamRef.current!));
    
    pc.ontrack = (event) => { 
        console.log("REMOTE STREAM RECEIVED");
        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = event.streams[0];
        }
    };
    
    pc.onicecandidate = (event) => { 
        if (event.candidate) {
            socketRef.current?.send(JSON.stringify({ type: 'ice', candidate: event.candidate })); 
        }
    };
    
    peerConnection.current = pc;

    socketRef.current = new WebSocket(getWsUrl());
    
    socketRef.current.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'identify') setRemoteSessionId(msg.sessionId);
        
        if (msg.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socketRef.current?.send(JSON.stringify({ type: 'answer', sdp: answer }));
            socketRef.current?.send(JSON.stringify({ type: 'identify', sessionId: activeSessionId }));
        } 
        else if (msg.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        } 
        else if (msg.type === 'ice') {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
        else if (msg.type === 'error' && msg.message === 'ROOM_FULL') {
            alert("Room is full! Only 2 people allowed.");
            window.location.reload();
        }
    };

    socketRef.current.onopen = async () => {
        setIceStatus('Negotiating...');
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current?.send(JSON.stringify({ type: 'offer', sdp: offer }));
        socketRef.current?.send(JSON.stringify({ type: 'identify', sessionId: activeSessionId }));
    };
  };

  // --- 5. CHALLENGE ---
  const triggerLivenessChallenge = async () => {
    if (challengeActiveRef.current || !landmarkerRef.current) return;
    challengeActiveRef.current = true;
    setChallengeActive(true);
    
    const challenges = [
        { text: "Turn Head LEFT ⬅️", check: (yaw: number) => yaw > 0.05 },
        { text: "Turn Head RIGHT ➡️", check: (yaw: number) => yaw < -0.05 }
    ];
    const selected = challenges[Math.floor(Math.random() * challenges.length)];
    setCurrentChallenge(selected.text);
    setStatusMessage('⚠️ SECURITY CHECK REQUIRED');

    const startTime = Date.now();
    let passed = false;

    while (Date.now() - startTime < 5000) {
        if (videoRef.current && landmarkerRef.current && 
            videoRef.current.readyState >= 2 && videoRef.current.videoWidth > 0) {
            try {
                const results = landmarkerRef.current.detectForVideo(videoRef.current, performance.now());
                if (results.faceLandmarks.length > 0) {
                     const landmarks = results.faceLandmarks[0];
                     const yaw = landmarks[234].z - landmarks[454].z;
                     if (selected.check(yaw)) { passed = true; break; }
                }
            } catch (e) {}
        }
        await new Promise(r => setTimeout(r, 100));
    }

    if (passed) {
        setTrustScore(100);
        setStatusMessage('Liveness Verified ✅');
        noFaceCounter.current = 0;
        lowBioCounter.current = 0;
        lastSuccessTimeRef.current = Date.now();
        await new Promise(r => setTimeout(r, 1500));
    } else {
        setTrustScore(0);
        setStatusMessage('Authentication Failed ❌');
    }

    setChallengeActive(false);
    setCurrentChallenge(null);
    challengeActiveRef.current = false;
  };

  // --- 6. MONITORING ---
  const startMonitoring = (activeSid: string) => {
    let seg = 1;
    monitoringRef.current = setInterval(async () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas) return;
        const isReady = video.readyState >= 2 && video.videoWidth > 0;
        
        if (landmarkerRef.current && isReady) {
            try {
                const results = landmarkerRef.current.detectForVideo(video, performance.now());
                if (results.faceLandmarks.length > 0) {
                    setFaceDetected(true);
                    noFaceCounter.current = 0; 
                    if (!challengeActiveRef.current && trustScoreRef.current > 0) {
                         setTrustScore(prev => Math.min(100, prev + 5));
                         if (trustScoreRef.current > 90) setStatusMessage("Secured (PPAH Active)");
                    }
                } else {
                    setFaceDetected(false);
                    noFaceCounter.current += 1;
                    if (noFaceCounter.current > 3 && !challengeActiveRef.current) {
                        handleSecurityEvent("No Face Detected", 10);
                    }
                }
            } catch (e) {}
        }

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx && isReady) {
            ctx.drawImage(video, 0, 0);
            const imgData = ctx.getImageData(0,0,640,480);
            if (seg === 1) workerRef.current?.postMessage({ type: 'GENERATE_ANCHOR', imageData: imgData });
            else if (!challengeActiveRef.current) {
                workerRef.current?.postMessage({ type: 'ANALYZE_FRAME', imageData: imgData, anchorBiometric: anchorBiometricRef.current });
            }
            const hashBuf = await crypto.subtle.digest('SHA-256', imgData.data);
            const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
            const sig = await signPacket(activeSid, seg, hashHex, trustScoreRef.current);
            await fetch(`${getBackendUrl()}/api/verify-hash`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ session_id: activeSid, segment_id: seg, hash: hashHex, trust_score: trustScoreRef.current, signature: sig })
            });
            seg++;
        }
    }, 1000); 
  };

  const initializeCamera = async () => {
    setStatusMessage('Initializing Camera...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      return true;
    } catch (e) { return false; }
  };

  const startVerification = async () => {
    if (!roomId.trim()) { setStatusMessage('❌ Enter Room Name'); return; }
    const authSuccess = await performWebAuthnLogin();
    if (!authSuccess) return;

    setStep('initializing');
    const cam = await initializeCamera();
    if (cam) {
        const res = await fetch(`${getBackendUrl()}/api/session/init`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ email: userEmail, webauthn_credential_id: webAuthnCredRef.current })
        });
        const data = await res.json();
        setSessionId(data.session_id);
        sessionKeyRef.current = data.session_key;
        
        startMonitoring(data.session_id);
        await startCall(data.session_id);
        setStep('active');
        setStatusMessage('Secure Call Active');
    }
  };

  const signPacket = async (sid: string, segId: number, hash: string, score: number) => {
    if (!sessionKeyRef.current) return "error";
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(sessionKeyRef.current), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${sid}${segId}${hash}${score}`));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  // --- DRAGGING HANDLERS ---
  const handleMouseDown = (e: React.MouseEvent) => {
    if (step !== 'active') return; 
    setIsDragging(true);
    setDragOffset({ x: e.clientX - pipPosition.x, y: e.clientY - pipPosition.y });
  };
  const handleMouseMove = (e: MouseEvent) => {
    if (isDragging) setPipPosition({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y });
  };
  const handleMouseUp = () => setIsDragging(false);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, dragOffset]);

  useEffect(() => {
    if (remoteSessionId) {
      const interval = setInterval(async () => {
          try {
              const res = await fetch(`${getBackendUrl()}/api/session/${remoteSessionId}/security-report`);
              if (res.ok) {
                  const data = await res.json();
                  setRemoteTrustScore(data.status === 'active' ? 100 : 0);
              }
          } catch (e) {}
      }, 2000); 
      return () => clearInterval(interval);
    }
  }, [remoteSessionId]);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6 flex justify-between items-center">
            <h1 className="text-2xl font-bold text-white flex gap-2 items-center"><Shield className="text-blue-500"/> PPAH Remote</h1>
            {step === 'idle' && (
                <div className="flex gap-4 items-center">
                     <button onClick={registerSecurityKey} className="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded flex items-center gap-1">
                        <PlusCircle size={14} /> Register Key
                     </button>
                     <input 
                        value={tempRoomId} 
                        onChange={(e) => setTempRoomId(e.target.value)} 
                        onKeyPress={(e) => e.key === 'Enter' && joinRoom()}
                        className="bg-slate-800 p-2 rounded text-sm border border-slate-600 focus:border-blue-500 outline-none" 
                        placeholder="Enter room (e.g., uk-meeting)"
                     />
                     <button onClick={joinRoom} className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded text-sm font-semibold">
                        Join Room
                     </button>
                </div>
            )}
            {step !== 'idle' && roomId && (
                <div className="flex gap-4 items-center">
                    <div className="bg-slate-800 px-4 py-2 rounded border border-blue-500/50">
                        <span className="text-xs text-slate-400">Room: </span>
                        <span className="font-mono text-blue-400 font-bold">{roomId}</span>
                    </div>
                    {/* STATUS INDICATOR */}
                    {step === 'active' && (
                        <div className={`px-3 py-1 rounded text-xs font-bold flex gap-1 items-center ${
                            iceStatus === 'Connected' ? 'bg-green-900 text-green-300' :
                            iceStatus === 'Failed' ? 'bg-red-900 text-red-300' : 'bg-yellow-900 text-yellow-300'
                        }`}>
                            <Signal size={12} /> {iceStatus}
                        </div>
                    )}
                </div>
            )}
        </header>

        {step === 'webauthn' && (
            <div className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center">
                <div className="bg-slate-800 p-8 rounded-2xl flex flex-col items-center animate-pulse border border-blue-500">
                    <Fingerprint className="w-16 h-16 text-blue-500 mb-4" />
                    <h2 className="text-xl font-bold text-white mb-2">Hardware Authentication</h2>
                    <p className="text-slate-400">Please touch your security key...</p>
                </div>
            </div>
        )}

        <div className="relative">
            {/* REMOTE VIDEO */}
            <div className={`bg-slate-800 rounded-2xl overflow-hidden shadow-xl border border-slate-700 relative h-[600px] transition-all duration-500 z-0`}>
                <div className="absolute top-4 left-4 z-10 bg-black/70 backdrop-blur px-3 py-1 rounded text-xs text-white font-semibold">
                    {remoteSessionId ? 'REMOTE USER' : 'WAITING FOR CONNECTION...'}
                </div>
                
                {/* IDLE UI */}
                {!inCall && step !== 'active' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-900">
                        <Phone size={48} className="mb-4 opacity-50" />
                        <p>{step === 'initializing' ? 'Initializing Camera...' : 'Waiting for connection...'}</p>
                        {roomId && <p className="text-xs mt-2 font-mono text-blue-400">Room: {roomId}</p>}
                    </div>
                )}
                
                {/* DIAGNOSTICS */}
                {iceStatus !== 'Connected' && inCall && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-20 text-center p-4">
                         <AlertCircle className="text-yellow-500 mb-2" size={32} />
                         <h3 className="text-white font-bold text-lg">Connecting...</h3>
                         <p className="text-slate-400 text-sm mb-4">Status: {iceStatus}</p>
                         <button onClick={restartIce} className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded text-white text-sm flex gap-2">
                             <RefreshCw size={14} /> Retry Connection
                         </button>
                    </div>
                )}

                <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover bg-black" />
                
                {/* Trust Score */}
                <div className="absolute bottom-4 left-4 right-4 z-10">
                    <div className="bg-black/70 backdrop-blur p-3 rounded-lg">
                        <div className="flex justify-between items-center mb-2">
                            <span className="text-xs uppercase text-slate-300">Remote Verification</span>
                            {remoteTrustScore !== null ? (
                                <span className={`font-mono font-bold flex gap-2 items-center ${remoteTrustScore > 80 ? 'text-green-400' : 'text-red-400'}`}>
                                    {remoteTrustScore > 80 ? <Shield size={14}/> : <AlertTriangle size={14}/>} {remoteTrustScore}%
                                </span>
                            ) : <span className="text-slate-400 text-xs">CONNECTING...</span>}
                        </div>
                        <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                            <div className={`h-full transition-all ${remoteTrustScore && remoteTrustScore > 80 ? 'bg-blue-500' : 'bg-red-500'}`} style={{width: `${remoteTrustScore || 0}%`}} />
                        </div>
                    </div>
                </div>
            </div>

            {/* YOUR VIDEO (PIP) */}
            {(step === 'active' || step === 'initializing') && (
                <div 
                    className={
                        step === 'initializing' 
                        ? "fixed inset-0 z-50 bg-slate-900 flex items-center justify-center"
                        : "absolute z-20 bg-slate-800 rounded-xl overflow-hidden shadow-2xl border-2 border-slate-600 cursor-move select-none"
                    }
                    style={step === 'active' ? {
                        left: `${pipPosition.x}px`,
                        top: `${pipPosition.y}px`,
                        width: '240px',
                        height: '320px'
                    } : {}}
                    onMouseDown={handleMouseDown}
                >
                    <div className="absolute top-2 left-2 z-30 bg-black/70 backdrop-blur px-2 py-1 rounded text-xs text-white font-semibold">YOU</div>
                    {step === 'active' && (
                        <div className="absolute top-2 right-2 z-30 bg-black/50 p-1 rounded-full"><Move size={12} className="text-white" /></div>
                    )}

                    <div className="relative h-full w-full">
                        <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover transform scale-x-[-1] bg-black" />
                        
                        {challengeActive && currentChallenge && (
                            <div className="absolute inset-0 bg-black/90 backdrop-blur z-20 flex flex-col items-center justify-center">
                                <div className="text-3xl mb-2">👮</div>
                                <h3 className="text-sm font-bold text-white mb-1">Security Check</h3>
                                <div className="text-sm text-yellow-400 font-mono font-bold bg-slate-900 px-3 py-1 rounded border border-yellow-500/50">{currentChallenge}</div>
                            </div>
                        )}
                        
                        {!faceDetected && !challengeActive && step === 'active' && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-red-900/50">
                                <div className="bg-red-600 text-white px-2 py-1 rounded text-xs font-bold flex gap-1 items-center"><UserX size={12} /> NO FACE</div>
                            </div>
                        )}
                    </div>
                    
                    <div className="absolute bottom-0 left-0 right-0 bg-black/80 backdrop-blur p-2">
                        <div className="flex justify-between items-center mb-1">
                            <span className="text-xs text-slate-300">Trust</span>
                            <span className={`font-mono text-xs font-bold ${trustScore > 80 ? 'text-green-400' : 'text-red-400'}`}>{trustScore}%</span>
                        </div>
                        <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                            <div className={`h-full transition-all duration-300 ${trustScore > 80 ? 'bg-green-500' : 'bg-red-500'}`} style={{width: `${trustScore}%`}} />
                        </div>
                        <div className="text-xs text-slate-400 mt-1 text-center truncate">{statusMessage}</div>
                    </div>
                </div>
            )}
        </div>
        
        <canvas ref={canvasRef} width={640} height={480} className="hidden" />

        <div className="mt-8 flex justify-center">
            {step === 'idle' ? (
                <button 
                    onClick={startVerification} 
                    disabled={!roomId.trim()}
                    className={`${roomId.trim() ? 'bg-blue-600 hover:bg-blue-500' : 'bg-slate-600 cursor-not-allowed'} text-white px-8 py-3 rounded-full font-bold flex items-center gap-2 transition-all`}
                >
                    <Phone size={20} /> Start Secure Video Call
                </button>
            ) : (
                <button onClick={() => window.location.reload()} className="bg-red-600 hover:bg-red-500 text-white px-8 py-3 rounded-full font-bold flex items-center gap-2 z-50 relative">
                    <PhoneOff size={20} /> End Call
                </button>
            )}
        </div>
      </div>
    </div>
  );
};

export default PPAHVerification;
