"use client";
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Shield, Mic, MicOff, Lock, Signal, AlertTriangle, 
  PhoneOff, Fingerprint, PlusCircle, UserX, Video
} from 'lucide-react';
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

// --- 1. ERROR SUPPRESSION ---
if (typeof window !== 'undefined') {
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = (...args) => {
    if (/NotAllowedError/.test(args[0]?.toString())) return;
    if (/Created TensorFlow Lite XNNPACK/.test(args[0]?.toString())) return;
    originalError.call(console, ...args);
  };
  console.info = (...args) => {
    if (/Created TensorFlow Lite XNNPACK/.test(args[0]?.toString())) return;
    originalInfo.call(console, ...args);
  };
}

const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

// --- SECURITY CONFIGURATION ---
const BANNED_DRIVERS = ['virtual', 'obs', 'manycam', 'loopback', 'vcam', 'droidcam'];

const PPAHVerification = () => {
  // --- STATE ---
  const [step, setStep] = useState('idle');
  const [userEmail, setUserEmail] = useState("user@example.com");
  const [sessionId, setSessionId] = useState<string | null>(null);
  
  // ROOM & CALL STATE
  const [roomId, setRoomId] = useState('');
  const [callDuration, setCallDuration] = useState(0);
  const [inCall, setInCall] = useState(false);
  const [isRemoteConnected, setIsRemoteConnected] = useState(false);
  const [showControls, setShowControls] = useState(true);
  
  // DIAGNOSTICS
  const [statusMessage, setStatusMessage] = useState('Ready');
  const [iceStatus, setIceStatus] = useState('New'); 
  const [trustScore, setTrustScore] = useState(100);
  const [remoteTrustScore, setRemoteTrustScore] = useState<number | null>(null);
  const [remoteSessionId, setRemoteSessionId] = useState<string | null>(null);
  
  // HARDWARE STATE
  const [isMuted, setIsMuted] = useState(false);

  // AI & CHALLENGE
  const [faceDetected, setFaceDetected] = useState(true);
  const [challengeActive, setChallengeActive] = useState(false);
  const [currentChallenge, setCurrentChallenge] = useState<string | null>(null);
  
  // PIP STATE
  const [pipPosition, setPipPosition] = useState({ x: 0, y: 0 }); 
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // --- REFS ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Security Refs
  const sessionKeyRef = useRef<string | null>(null);
  const webAuthnCredRef = useRef<string | null>(null);
  const anchorBiometricRef = useRef<any | null>(null);
  const workerRef = useRef<Worker | null>(null);
  
  // CHANGED: monitoringRef is now for setTimeout, not setInterval
  const monitoringRef = useRef<NodeJS.Timeout | null>(null);
  
  const trustScoreRef = useRef(trustScore); 
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const challengeActiveRef = useRef(false);
  
  const noFaceCounter = useRef(0);
  const lowBioCounter = useRef(0);
  const lastSuccessTimeRef = useRef<number>(0);

  useEffect(() => { trustScoreRef.current = trustScore; }, [trustScore]);

  // --- ENFORCEMENT ---
  useEffect(() => {
    if (!inCall) return;
    if (trustScore === 0) terminateSession("Security Violation: Local Trust Lost");
    if (remoteTrustScore !== null && remoteTrustScore === 0) terminateSession("Security Violation: Remote Peer Untrusted");
  }, [trustScore, remoteTrustScore, inCall]);

  const terminateSession = (reason: string) => {
      alert(reason);
      window.location.reload();
  };

  // --- INITIAL LAYOUT ---
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setPipPosition({ x: window.innerWidth - 160, y: 80 });
    }
  }, []);

  // --- API HELPERS ---
  const getBackendUrl = () => ""; 
  const getWsUrl = () => {
    if (typeof window !== 'undefined') {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/ws/${roomId}`;
    }
    return '';
  };

  // --- CONTROLS VISIBILITY ---
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (inCall) setShowControls(false);
    }, 3000); 
  }, [inCall]);

  const toggleControls = (e: React.MouseEvent) => {
    if (isDragging) return;
    if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('input')) {
      resetControlsTimer();
      return;
    }
    if (showControls) {
      setShowControls(false);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    } else {
      resetControlsTimer();
    }
  };

  useEffect(() => {
    if (inCall) resetControlsTimer();
    return () => { if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current); }
  }, [inCall, resetControlsTimer]);

  // --- 2. INITIALIZE MEDIA PIPE ---
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
             if (lowBioCounter.current > 3) handleSecurityEvent("Identity Mismatch", 15);
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
      if (Date.now() - lastSuccessTimeRef.current < 5000) { 
          setTrustScore(prev => Math.min(100, prev + 1)); 
          return;
      }
      setTrustScore(prev => {
          const newScore = Math.max(0, prev - penalty);
          if (newScore < 40 && !challengeActiveRef.current) triggerLivenessChallenge();
          return newScore;
      });
  };

  const cleanup = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    if (socketRef.current) socketRef.current.close();
    if (peerConnection.current) peerConnection.current.close();
    // CHANGED: Use clearTimeout instead of clearInterval
    if (monitoringRef.current) clearTimeout(monitoringRef.current);
  };

  const toggleMute = () => {
    if (streamRef.current) {
      const audioTrack = streamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
        resetControlsTimer();
      }
    }
  };

  // --- 4. SIGNALING & CONNECTIVITY ---
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
    setInCall(true);
    
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
        setIceStatus(state.charAt(0).toUpperCase() + state.slice(1));
        
        if (state === 'connected' || state === 'completed') {
            setIsRemoteConnected(true);
        } else if (state === 'disconnected' || state === 'failed') {
            setIsRemoteConnected(false);
        }
    };

    streamRef.current.getTracks().forEach(track => pc.addTrack(track, streamRef.current!));
    
    pc.ontrack = (event) => { 
        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = event.streams[0];
            setIsRemoteConnected(true);
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
        
        if (msg.type === 'peer_left') {
            setIsRemoteConnected(false); // STOP TIMER INSTANTLY
            setRemoteTrustScore(null);
            if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        }

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

  // --- 5. TIMER LOGIC (STRICT SYNC) ---
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isRemoteConnected) {
        setCallDuration(0);
        timer = setInterval(() => {
            setCallDuration(prev => prev + 1);
        }, 1000);
    }
    return () => clearInterval(timer);
  }, [isRemoteConnected]);

  // --- 6. CHALLENGE LOGIC ---
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
    setStatusMessage('⚠️ SECURITY CHECK');

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
        setStatusMessage('Verified');
        noFaceCounter.current = 0;
        lowBioCounter.current = 0;
        lastSuccessTimeRef.current = Date.now();
        await new Promise(r => setTimeout(r, 1500));
    } else {
        setTrustScore(0);
        setStatusMessage('Failed');
    }

    setChallengeActive(false);
    setCurrentChallenge(null);
    challengeActiveRef.current = false;
  };

  // --- 7. MONITORING LOOP (ADAPTIVE UPDATE) ---
  const startMonitoring = (activeSid: string) => {
    let seg = 1;
    let isRunning = true; 

    // RECURSIVE LOOP FOR ADAPTIVE TIMING
    const loop = async () => {
        if (!isRunning) return; 

        const startTime = Date.now();
        const video = videoRef.current;
        const canvas = canvasRef.current;

        // Perform Checks if Video Ready
        if (video && canvas && landmarkerRef.current && video.readyState >= 2) {
            try {
                const results = landmarkerRef.current.detectForVideo(video, performance.now());
                if (results.faceLandmarks.length > 0) {
                    setFaceDetected(true);
                    noFaceCounter.current = 0; 
                    if (!challengeActiveRef.current && trustScoreRef.current > 0) {
                         setTrustScore(prev => Math.min(100, prev + 5));
                         if (trustScoreRef.current > 90) setStatusMessage("Secured");
                    }
                } else {
                    setFaceDetected(false);
                    noFaceCounter.current += 1;
                    if (noFaceCounter.current > 3 && !challengeActiveRef.current) {
                        handleSecurityEvent("No Face", 15);
                    }
                }
            } catch (e) {}

            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
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
        }

        // --- ADAPTIVE LOGIC ---
        // If Trust is low OR Network is unstable -> Speed up to 200ms
        let nextDelay = 1000;
        if (trustScoreRef.current < 80 || iceStatus !== 'Connected') {
            nextDelay = 200; // FAST MODE
        }

        const processingTime = Date.now() - startTime;
        const actualDelay = Math.max(0, nextDelay - processingTime);
        
        monitoringRef.current = setTimeout(loop, actualDelay);
    };

    loop(); // Start the loop
  };

  // --- AUTH & INIT (UPDATED WITH BLOCKER) ---
  const initializeCamera = async () => {
    setStatusMessage('Init Camera...');
    try {
      // 1. VIRTUAL CAMERA BLOCKADE
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      
      for (const device of videoInputs) {
          const label = device.label.toLowerCase();
          // Check for banned keywords in available devices
          if (BANNED_DRIVERS.some(banned => label.includes(banned))) {
              alert(`SECURITY ALERT: Virtual Camera Detected (${device.label}). Access Denied.`);
              return false;
          }
      }

      // 2. REQUEST STREAM
      const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: true 
      });

      // 3. DOUBLE CHECK ACTIVE TRACK (Post-Permission)
      const track = stream.getVideoTracks()[0];
      const activeLabel = track.label.toLowerCase();
      if (BANNED_DRIVERS.some(banned => activeLabel.includes(banned))) {
          track.stop();
          alert("SECURITY ALERT: Virtual Driver Blocked.");
          return false;
      }

      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      return true;
    } catch (e) { 
        console.error(e);
        alert("Camera access denied! Please enable camera.");
        return false; 
    }
  };

  const registerSecurityKey = async () => {
    try {
        setStatusMessage("Registering...");
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
        if (verifyResp.ok) alert("Security Key Registered Successfully!");
        else alert("Registration Failed");
        setStatusMessage("Ready");
    } catch (error: any) {
        setStatusMessage("Ready");
        alert(error.name === 'NotAllowedError' ? "Registration Cancelled" : "Registration Error");
    }
  };

  const performWebAuthnLogin = async () => {
    setStep('webauthn');
    setStatusMessage('Authenticating...');
    try {
        const resp = await fetch(`${getBackendUrl()}/api/webauthn/login/options`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ email: userEmail })
        });
        if (!resp.ok) {
            alert("User not found. Please Register Key first!");
            setStep('idle');
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
            return true;
        }
    } catch (error: any) {
        setStep('idle');
        if (error.name !== 'NotAllowedError') {
            alert("Authentication Failed");
        }
    }
    return false;
  };

  const startVerification = async () => {
    if (!roomId.trim()) { alert('Please enter a Room ID'); return; }
    
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
        setStatusMessage('Secured');
    } else {
        setStep('idle');
    }
  };

  const signPacket = async (sid: string, segId: number, hash: string, score: number) => {
    if (!sessionKeyRef.current) return "error";
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(sessionKeyRef.current), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${sid}${segId}${hash}${score}`));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  // --- DRAGGING & SNAPPING ---
  const handleMouseDown = (e: React.MouseEvent) => {
    if (step !== 'active') return; 
    setIsDragging(true);
    setDragOffset({ x: e.clientX - pipPosition.x, y: e.clientY - pipPosition.y });
  };
  
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (isDragging) setPipPosition({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y });
  }, [isDragging, dragOffset]);
  
  const handleMouseUp = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    
    const margin = 16;
    const width = 140; 
    const height = 180;
    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    
    const corners = [
      { x: margin, y: 80 }, 
      { x: screenW - width - margin, y: 80 }, 
      { x: margin, y: screenH - height - 120 }, 
      { x: screenW - width - margin, y: screenH - height - 120 } 
    ];
    
    const closest = corners.reduce((prev, curr) => {
      const prevDist = Math.hypot(prev.x - pipPosition.x, prev.y - pipPosition.y);
      const currDist = Math.hypot(curr.x - pipPosition.x, curr.y - pipPosition.y);
      return currDist < prevDist ? curr : prev;
    });
    
    setPipPosition(closest);
  }, [isDragging, pipPosition]);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // --- REMOTE POLL ---
  useEffect(() => {
    if (remoteSessionId) {
      const interval = setInterval(async () => {
          try {
              // Add timestamp to bust cache
              const res = await fetch(`${getBackendUrl()}/api/session/${remoteSessionId}/security-report?t=${Date.now()}`);
              if (res.ok) {
                  const data = await res.json();
                  if (data.score !== undefined) {
                      setRemoteTrustScore(data.score);
                  } else {
                      setRemoteTrustScore(data.status === 'active' ? 100 : 0);
                  }
              }
          } catch (e) {}
      }, 1000); 
      return () => clearInterval(interval);
    }
  }, [remoteSessionId]);

  return (
    <div className="h-screen w-screen bg-black overflow-hidden relative font-sans select-none" onClick={toggleControls}>
      
      {/* 1. REMOTE VIDEO (FULL SCREEN) */}
      <video 
        ref={remoteVideoRef} 
        autoPlay 
        playsInline 
        className="absolute inset-0 w-full h-full object-cover z-0 transition-all duration-300 ease-in-out" 
        style={{
            filter: remoteTrustScore !== null && remoteTrustScore < 60 ? 'blur(20px)' : 'none'
        }}
      />
      
      {/* 2. TOP BAR (AUTO HIDE) */}
      <div className={`fixed top-0 left-0 right-0 z-20 transition-all duration-300 transform ${showControls || !inCall ? 'translate-y-0 opacity-100' : '-translate-y-full opacity-0'}`}>
        <div className="bg-gradient-to-b from-black/70 to-transparent pt-4 pb-12 px-4 flex justify-between items-start">
            <div className="flex flex-col text-white/90">
              <div className="flex items-center gap-2">
                 <h2 className="text-lg font-semibold drop-shadow-md">{roomId || "PPAH Secure"}</h2>
                 {inCall && <div className="bg-blue-600/20 px-2 py-0.5 rounded text-[10px] text-blue-400 font-bold border border-blue-500/30">ENCRYPTED</div>}
              </div>
              {/* TIMER ONLY SHOWS IF REMOTE IS CONNECTED */}
              {isRemoteConnected && <span className="text-sm font-medium opacity-80">{formatTime(callDuration)}</span>}
            </div>

            {/* Right: Security Badges (SUBTLE) */}
            {inCall && (
                <div className="flex flex-col items-end gap-1">
                   {remoteTrustScore !== null && (
                     <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full backdrop-blur-md border ${remoteTrustScore > 80 ? 'bg-green-900/40 border-green-500/30 text-green-400' : 'bg-red-900/40 border-red-500/30 text-red-400'}`}>
                        <Shield size={12} fill="currentColor" />
                        <span className="text-xs font-bold">{remoteTrustScore}%</span>
                     </div>
                   )}
                   <div className="flex items-center gap-1 opacity-60">
                      <Signal size={12} className={iceStatus === 'Connected' ? 'text-green-400' : 'text-yellow-400'} />
                      <span className="text-[10px] text-white uppercase tracking-wider">{iceStatus}</span>
                   </div>
                </div>
            )}
        </div>
      </div>

      {/* 3. PIP (DRAGGABLE, SNAPPING) */}
      {(step === 'active' || step === 'initializing') && (
         <div 
           className={`absolute z-30 overflow-hidden rounded-xl shadow-2xl transition-all duration-300 ease-out border border-white/10 ${isDragging ? 'scale-105 shadow-xl cursor-grabbing' : 'cursor-grab'}`}
           style={{
             width: '140px',
             height: '180px',
             transform: `translate(${pipPosition.x}px, ${pipPosition.y}px)`,
             boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
           }}
           onMouseDown={handleMouseDown}
           onClick={(e) => e.stopPropagation()} 
         >
            <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover transform scale-x-[-1] bg-slate-800" />
            
            <div className="absolute bottom-2 left-2 right-2 flex justify-between items-end">
               <div className={`p-1 rounded-full bg-black/40 backdrop-blur border border-white/10 ${faceDetected ? 'text-green-400' : 'text-red-400'}`}>
                  {faceDetected ? <Lock size={10} /> : <AlertTriangle size={10} />}
               </div>
               <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/40 backdrop-blur ${trustScore > 80 ? 'text-green-400' : 'text-red-400'}`}>
                 {trustScore}%
               </span>
            </div>

            {challengeActive && (
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center text-center p-2">
                   <Shield className="text-yellow-500 mb-1 animate-bounce" size={24} />
                   <p className="text-[10px] font-bold text-white leading-tight">{currentChallenge}</p>
                </div>
            )}
            
            {!faceDetected && !challengeActive && (
                <div className="absolute inset-0 flex items-center justify-center bg-red-900/50 backdrop-blur-[1px]">
                   <UserX className="text-red-400" size={32} />
                </div>
            )}
         </div>
      )}

      {/* 4. BOTTOM CONTROLS (AUTO HIDE) */}
      <div className={`fixed bottom-0 left-0 right-0 z-40 transition-all duration-300 transform ${showControls ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'}`}>
        <div className="bg-gradient-to-t from-black/90 via-black/50 to-transparent pb-8 pt-12 px-6 flex justify-center items-center gap-6">
            
            {step === 'active' && (
              <>
                <button onClick={toggleMute} className={`w-14 h-14 rounded-full flex items-center justify-center text-white transition-all shadow-lg active:scale-95 ${isMuted ? 'bg-red-500' : 'bg-white/10 backdrop-blur-md hover:bg-white/20'}`}>
                   {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                </button>
                
                <button onClick={() => window.location.reload()} className="w-16 h-16 rounded-full bg-red-600 flex items-center justify-center text-white shadow-red-900/50 shadow-lg hover:bg-red-500 transition-all transform active:scale-95">
                   <PhoneOff size={32} fill="currentColor" />
                </button>
              </>
            )}

        </div>
      </div>

      {/* 5. IDLE / WAITING OVERLAY */}
      {step === 'idle' && (
         <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
            <div className="bg-black/40 backdrop-blur-xl p-6 rounded-2xl border border-white/10 text-center pointer-events-auto shadow-2xl">
               <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-[0_0_20px_rgba(37,99,235,0.4)]">
                 <Shield size={32} className="text-white" />
               </div>
               <h1 className="text-2xl font-bold text-white mb-2">PPAH Secure Call</h1>
               
               <p className="text-white/60 text-sm mb-6 max-w-sm mx-auto leading-relaxed">
                 End-to-end encrypted<br />
                 Biometric verification enabled
               </p>
               
               <input 
                  value={roomId} 
                  onChange={(e) => setRoomId(e.target.value)} 
                  className="bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white placeholder:text-white/30 w-full text-center outline-none focus:border-blue-500 transition-colors mb-4"
                  placeholder="Enter Room Name..."
               />
               
               <button 
                  onClick={startVerification} 
                  disabled={!roomId}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-lg font-bold shadow-lg flex items-center justify-center gap-2 hover:brightness-110 active:scale-95 transition-all disabled:opacity-50 disabled:grayscale mb-4"
               >
                  <Video size={20} fill="currentColor" /> Start Video Call
               </button>

               <div className="flex justify-center">
                 <button onClick={registerSecurityKey} className="text-xs text-white/40 hover:text-blue-400 transition-colors flex items-center gap-1">
                   <PlusCircle size={10} /> Register Security Key
                 </button>
               </div>
            </div>
         </div>
      )}

      {/* WebAuthn Animation Overlay */}
      {step === 'webauthn' && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-md z-50 flex flex-col items-center justify-center text-white">
           <Fingerprint className="w-16 h-16 text-blue-500 animate-pulse mb-4" />
           <h3 className="text-xl font-bold">Verifying Identity...</h3>
           <p className="text-white/50 text-sm mt-2">Touch your security key</p>
        </div>
      )}

      {/* Hidden Analysis Canvas */}
      <canvas ref={canvasRef} width={640} height={480} className="hidden" />
    </div>
  );
};

export default PPAHVerification;
