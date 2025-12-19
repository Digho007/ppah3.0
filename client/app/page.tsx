"use client";
import React, { useState, useRef, useEffect } from 'react';
import { 
  Shield, Phone, PhoneOff, UserX, Fingerprint, PlusCircle, 
  Move, Signal, RefreshCw, AlertCircle, AlertTriangle, Lock, Unlock
} from 'lucide-react';
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
  const [statusMessage, setStatusMessage] = useState('System Ready');
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
  const [pipPosition, setPipPosition] = useState({ x: 20, y: 100 });
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
    setIceStatus('Connecting...');
    
    const pc = new RTCPeerConnection({ 
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            {
                urls: "turn:relay1.expressturn.com:3480", 
                username: "000000002081401268", 
                credential: "cTgF/eRaT2gKMgz80O1wl1DbNCo=" 
            },
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
            // UPDATE: Only set inCall to true when we actually get tracks
            setInCall(true); 
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
      const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: 640, height: 480 },
          audio: true 
      });
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
    // UPDATED: Draggable only if step is active AND we are inCall (connected to peer)
    if (step !== 'active' || !inCall) return; 
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
    <div className="min-h-screen bg-slate-900 text-slate-200 p-8 font-sans select-none overflow-hidden">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6 flex justify-between items-center">
            <h1 className="text-2xl font-bold text-white flex gap-2 items-center">
              <div className="bg-blue-600 p-1.5 rounded-lg">
                <Shield size={20} className="text-white"/>
              </div> 
              PPAH Remote
            </h1>
            {step === 'idle' && (
                <div className="flex gap-4 items-center">
                     <button onClick={registerSecurityKey} className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2 rounded-lg flex items-center gap-1.5 border border-slate-700 transition-colors">
                        <PlusCircle size={14} /> Register Key
                     </button>
                     <div className="relative">
                        <input 
                          value={tempRoomId} 
                          onChange={(e) => setTempRoomId(e.target.value)} 
                          onKeyPress={(e) => e.key === 'Enter' && joinRoom()}
                          className="bg-slate-800 px-4 py-2 rounded-lg text-sm border border-slate-700 focus:border-blue-500 outline-none w-48 transition-all" 
                          placeholder="Secure Room ID"
                        />
                     </div>
                     <button onClick={joinRoom} className="bg-blue-600 hover:bg-blue-500 px-5 py-2 rounded-lg text-sm font-semibold transition-all shadow-lg shadow-blue-900/20">
                        Join
                     </button>
                </div>
            )}
            {step !== 'idle' && roomId && (
                <div className="flex gap-4 items-center">
                    <div className="bg-slate-800/50 backdrop-blur px-4 py-2 rounded-lg border border-blue-500/30 flex flex-col">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Encrypted Session</span>
                        <span className="font-mono text-blue-400 font-bold text-sm">{roomId}</span>
                    </div>
                    {step === 'active' && (
                        <div className={`px-4 py-2 rounded-lg text-xs font-bold flex gap-2 items-center border ${
                            iceStatus === 'Connected' || iceStatus === 'Completed' 
                            ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                            iceStatus === 'Failed' ? 'bg-red-500/10 text-red-400 border-red-500/20' : 
                            'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                        }`}>
                            <div className={`w-2 h-2 rounded-full animate-pulse ${
                              iceStatus === 'Connected' || iceStatus === 'Completed' ? 'bg-green-500' : 'bg-yellow-500'
                            }`} />
                            {iceStatus.toUpperCase()}
                        </div>
                    )}
                </div>
            )}
        </header>

        {step === 'webauthn' && (
            <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[100] flex flex-col items-center justify-center">
                <div className="bg-slate-800 p-10 rounded-3xl flex flex-col items-center shadow-2xl border border-blue-500/50 max-w-sm text-center">
                    <div className="w-20 h-20 bg-blue-600/20 rounded-full flex items-center justify-center mb-6 animate-pulse">
                      <Fingerprint className="w-10 h-10 text-blue-500" />
                    </div>
                    <h2 className="text-2xl font-bold text-white mb-3">Hardware Authentication</h2>
                    <p className="text-slate-400 mb-6 leading-relaxed">Touch the sensor on your physical security key to authorize this encrypted session.</p>
                    <div className="flex gap-2">
                       <div className="w-2 h-2 rounded-full bg-blue-500 animate-bounce [animation-delay:-0.3s]"></div>
                       <div className="w-2 h-2 rounded-full bg-blue-500 animate-bounce [animation-delay:-0.15s]"></div>
                       <div className="w-2 h-2 rounded-full bg-blue-500 animate-bounce"></div>
                    </div>
                </div>
            </div>
        )}

        <div className="relative">
            {/* REMOTE VIDEO CONTAINER */}
            <div className={`bg-slate-800 rounded-3xl overflow-hidden shadow-2xl border border-slate-700/50 relative h-[650px] transition-all duration-500 group`}>
                <div className="absolute top-6 left-6 z-10 flex gap-2">
                  <div className="bg-black/60 backdrop-blur-md px-4 py-1.5 rounded-full text-[10px] tracking-widest text-white font-black uppercase flex items-center gap-2 border border-white/10">
                    <div className={`w-1.5 h-1.5 rounded-full ${remoteSessionId ? 'bg-green-500' : 'bg-red-500'}`} />
                    {remoteSessionId ? 'REMOTE LINK ESTABLISHED' : 'LINKING...'}
                  </div>
                </div>
                
                {/* IDLE / WAITING UI */}
                {!inCall && step !== 'active' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-900/80 backdrop-blur-xl">
                        <div className="w-24 h-24 bg-slate-800 rounded-full flex items-center justify-center mb-6 shadow-inner border border-slate-700">
                          <Phone size={40} className="opacity-40" />
                        </div>
                        <h3 className="text-xl font-semibold text-white mb-2">
                          {step === 'initializing' ? 'Activating Hardened Module...' : 'Waiting for Remote Peer...'}
                        </h3>
                        <p className="text-sm text-slate-500">Secure Protocol v4.2.0-AEAD</p>
                        {roomId && (
                          <div className="mt-8 flex flex-col items-center">
                            <p className="text-xs text-slate-500 mb-2 font-bold uppercase tracking-widest">Share this Room ID</p>
                            <code className="bg-blue-900/20 text-blue-400 px-4 py-2 rounded-lg border border-blue-500/20 font-mono text-lg">{roomId}</code>
                          </div>
                        )}
                    </div>
                )}
                
                {/* CONNECTION DIAGNOSTICS OVERLAY */}
                {iceStatus !== 'Connected' && iceStatus !== 'Completed' && inCall && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-20 text-center p-8 backdrop-blur-sm">
                         <div className="bg-yellow-500/10 p-4 rounded-full mb-4">
                           <AlertCircle className="text-yellow-500" size={40} />
                         </div>
                         <h3 className="text-white font-bold text-2xl mb-2">Signal Degraded</h3>
                         <p className="text-slate-400 text-sm mb-8 max-w-xs">Peer connection state: <span className="text-yellow-400 font-mono">{iceStatus}</span>. Checking ICE candidates...</p>
                         <button onClick={restartIce} className="bg-white/10 hover:bg-white/20 px-6 py-3 rounded-xl text-white text-sm font-bold flex gap-2 items-center transition-all border border-white/10">
                             <RefreshCw size={16} /> Force Signal Reset
                         </button>
                    </div>
                )}

                <video 
                  ref={remoteVideoRef} 
                  autoPlay 
                  playsInline 
                  className="w-full h-full object-cover bg-slate-950" 
                />
                
                {/* Remote Trust Score Indicator (Bottom) */}
                <div className="absolute bottom-6 left-6 right-6 z-10">
                    <div className="bg-slate-900/60 backdrop-blur-xl p-5 rounded-2xl border border-white/10 shadow-2xl">
                        <div className="flex justify-between items-end mb-3">
                            <div>
                              <p className="text-[10px] uppercase tracking-tighter text-slate-400 font-black">Remote Security Baseline</p>
                              <h4 className="text-white font-bold">Verification Engine v2</h4>
                            </div>
                            {remoteTrustScore !== null ? (
                                <div className={`flex flex-col items-end`}>
                                    <span className={`text-2xl font-mono font-black flex gap-2 items-center ${remoteTrustScore > 80 ? 'text-green-400' : 'text-red-400'}`}>
                                        {remoteTrustScore > 80 ? <Shield size={20}/> : <AlertTriangle size={20}/>} {remoteTrustScore}%
                                    </span>
                                    <span className="text-[10px] text-slate-500 uppercase font-bold">Confidence Score</span>
                                </div>
                            ) : (
                              <div className="animate-pulse flex items-center gap-2">
                                <div className="w-2 h-2 bg-slate-600 rounded-full" />
                                <span className="text-slate-500 text-[10px] font-black tracking-widest">ANALYZING PEER...</span>
                              </div>
                            )}
                        </div>
                        <div className="h-3 bg-white/5 rounded-full overflow-hidden border border-white/5 p-0.5">
                            <div 
                              className={`h-full rounded-full transition-all duration-1000 ease-out ${
                                remoteTrustScore && remoteTrustScore > 80 ? 'bg-gradient-to-r from-blue-600 to-green-500' : 'bg-red-500'
                              }`} 
                              style={{width: `${remoteTrustScore || 0}%`}} 
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* YOUR VIDEO (PIP - DRAGGABLE ONLY WHEN CONNECTED) */}
            {(step === 'active' || step === 'initializing') && (
                <div 
                    className={
                        step === 'initializing' 
                        ? "fixed inset-0 z-50 bg-slate-950 flex items-center justify-center"
                        : `absolute z-30 bg-slate-900 rounded-2xl overflow-hidden shadow-[0_0_50px_rgba(0,0,0,0.5)] border-2 transition-all duration-300 ${
                            inCall 
                            ? 'border-blue-500/50 cursor-move hover:scale-[1.02] shadow-blue-500/10' 
                            : 'border-slate-700/50 cursor-default opacity-90'
                          }`
                    }
                    style={step === 'active' ? {
                        left: `${pipPosition.x}px`,
                        top: `${pipPosition.y}px`,
                        width: '260px',
                        height: '350px'
                    } : {}}
                    onMouseDown={handleMouseDown}
                >
                    <div className="absolute top-3 left-3 z-40 flex items-center gap-2">
                        <div className="bg-black/60 backdrop-blur-md px-3 py-1 rounded-full text-[9px] tracking-widest text-white font-black border border-white/5 uppercase">
                          Local Monitoring
                        </div>
                        {step === 'active' && (
                          <div className={`px-2 py-1 rounded-full text-[8px] font-black uppercase tracking-tighter flex items-center gap-1 border ${
                            inCall ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' : 'bg-slate-800 text-slate-500 border-slate-700'
                          }`}>
                            {inCall ? <Unlock size={10} /> : <Lock size={10} />}
                            {inCall ? 'Unlocked' : 'Locked'}
                          </div>
                        )}
                    </div>

                    {step === 'active' && inCall && (
                        <div className="absolute top-3 right-3 z-40 bg-blue-500/80 p-1.5 rounded-full border border-white/20 shadow-lg animate-pulse">
                          <Move size={12} className="text-white" />
                        </div>
                    )}

                    <div className="relative h-full w-full">
                        <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover transform scale-x-[-1] bg-slate-950" />
                        
                        {/* Security Challenge Overlay */}
                        {challengeActive && currentChallenge && (
                            <div className="absolute inset-0 bg-blue-950/80 backdrop-blur-md z-20 flex flex-col items-center justify-center p-6 text-center">
                                <div className="w-12 h-12 bg-yellow-500/20 rounded-full flex items-center justify-center mb-4 border border-yellow-500/40">
                                  <Shield className="text-yellow-500" size={24} />
                                </div>
                                <h3 className="text-xs font-black text-white mb-2 uppercase tracking-widest">Active Challenge</h3>
                                <div className="text-sm text-yellow-300 font-mono font-bold bg-black/40 px-4 py-2 rounded-xl border border-yellow-500/30 shadow-lg">
                                  {currentChallenge}
                                </div>
                                <p className="text-[10px] text-slate-400 mt-4 leading-tight">AI verification required to maintain session trust.</p>
                            </div>
                        )}
                        
                        {!faceDetected && !challengeActive && step === 'active' && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-red-950/60 backdrop-blur-[2px]">
                                <div className="bg-red-600 text-white px-4 py-2 rounded-xl text-[10px] font-black tracking-tighter shadow-xl flex gap-2 items-center border border-red-400/50">
                                  <UserX size={16} /> FACE MISSING
                                </div>
                            </div>
                        )}
                    </div>
                    
                    <div className="absolute bottom-0 left-0 right-0 bg-slate-900/90 backdrop-blur-xl p-4 border-t border-white/5">
                        <div className="flex justify-between items-center mb-1.5">
                            <span className="text-[10px] font-black uppercase text-slate-500 tracking-wider">Local Trust</span>
                            <span className={`font-mono text-xs font-black ${trustScore > 80 ? 'text-green-400' : 'text-red-400'}`}>{trustScore}%</span>
                        </div>
                        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden mb-2">
                            <div 
                              className={`h-full transition-all duration-700 ${trustScore > 80 ? 'bg-green-500' : 'bg-red-500'}`} 
                              style={{width: `${trustScore}%`}} 
                            />
                        </div>
                        <div className="text-[9px] text-slate-400 font-bold uppercase tracking-widest text-center truncate px-2 opacity-80">{statusMessage}</div>
                    </div>
                </div>
            )}
        </div>
        
        {/* Hidden analysis canvas */}
        <canvas ref={canvasRef} width={640} height={480} className="hidden" />

        <div className="mt-10 flex flex-col items-center gap-4">
            {step === 'idle' ? (
                <div className="flex flex-col items-center gap-3">
                  <button 
                      onClick={startVerification} 
                      disabled={!roomId.trim()}
                      className={`${roomId.trim() ? 'bg-blue-600 hover:bg-blue-500 shadow-blue-600/20' : 'bg-slate-700 cursor-not-allowed opacity-50'} text-white px-12 py-4 rounded-full font-black uppercase tracking-widest flex items-center gap-3 transition-all transform active:scale-95 shadow-xl group`}
                  >
                      <Phone size={20} className="group-hover:rotate-12 transition-transform" /> Start Hardened Session
                  </button>
                  <p className="text-[10px] text-slate-500 font-bold tracking-tighter uppercase opacity-50">Peer-to-Peer • End-to-End Encrypted • AI Verified</p>
                </div>
            ) : (
                <button onClick={() => window.location.reload()} className="bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white px-10 py-4 rounded-full font-black uppercase tracking-widest flex items-center gap-3 transition-all border border-red-500/20 z-50 group">
                    <PhoneOff size={20} className="group-hover:-rotate-12 transition-transform" /> Terminate Link
                </button>
            )}
        </div>
      </div>
    </div>
  );
};

export default PPAHVerification;
