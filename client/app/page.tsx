"use client";
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Shield, Mic, MicOff, Lock, Signal, AlertTriangle, 
  PhoneOff, Fingerprint, PlusCircle, UserX, Video
} from 'lucide-react';
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

// --- 1. ERROR FILTERING (Updated for Better Debugging) ---
if (typeof window !== 'undefined') {
  const originalError = console.error;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  
  console.error = (...args) => {
    // Filter known harmless errors
    if (/NotAllowedError/.test(args[0]?.toString())) return;
    if (/Created TensorFlow Lite XNNPACK/.test(args[0]?.toString())) return;
    // Log all other errors with context
    originalError.call(console, '[PPAH Error]', ...args);
  };
  
  console.info = (...args) => {
    // Filter TensorFlow noise
    if (/Created TensorFlow Lite XNNPACK/.test(args[0]?.toString())) return;
    originalInfo.call(console, ...args);
  };
  
  console.warn = (...args) => {
    // Always log warnings with PPAH tag for easier filtering
    originalWarn.call(console, '[PPAH Warning]', ...args);
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
  
  // NEW STATE: PASSIVE LIVENESS (FLASH)
  const [isFlashActive, setIsFlashActive] = useState(false);
  
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
  
  // NEW REFS: BRIGHTNESS HEURISTIC
  const previousBrightnessRef = useRef<number | null>(null);
  const brightnessVolatilityRef = useRef<number>(0);
  const baselineBrightnessRef = useRef<number>(0);
  const brightnessHistoryRef = useRef<number[]>([]);
  const colorEntropyRef = useRef<number>(0);
  const previousColorEntropyRef = useRef<number | null>(null);
  
  // EMA for trust score (Exponential Moving Average)
  const trustScoreEMA = useRef<number>(100);
  const EMA_ALPHA = 0.3; // Smoothing factor (0-1, lower = more smoothing)
  
  // Environmental stability tracking
  const environmentStableCountRef = useRef<number>(0);
  const lastBrightnessChangeRef = useRef<number>(Date.now());
  
  // Loop Control Refs
  const monitoringRef = useRef<NodeJS.Timeout | null>(null);
  const isMonitoringActive = useRef(false); // Prevents Zombie Loops
  
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
      
      console.log(`[PPAH Security] Event: ${reason}, Penalty: ${penalty}, Current Score: ${trustScoreRef.current}`);
      
      if (Date.now() - lastSuccessTimeRef.current < 5000) { 
          setTrustScore(prev => Math.min(100, prev + 1)); 
          return;
      }
      
      setTrustScore(prev => {
          const targetScore = Math.max(0, prev - penalty);
          
          // Apply EMA smoothing to avoid abrupt changes
          const smoothedScore = Math.round(
            trustScoreEMA.current * (1 - EMA_ALPHA) + targetScore * EMA_ALPHA
          );
          trustScoreEMA.current = smoothedScore;
          
          const newScore = Math.max(0, Math.min(100, smoothedScore));
          
          if (newScore < 40 && !challengeActiveRef.current) {
            console.warn(`[PPAH Security] Trust score critically low (${newScore}%), triggering liveness challenge`);
            triggerLivenessChallenge();
          }
          
          return newScore;
      });
  };

  const cleanup = () => {
    isMonitoringActive.current = false; // STOP LOOP
    streamRef.current?.getTracks().forEach(t => t.stop());
    if (socketRef.current) socketRef.current.close();
    if (peerConnection.current) peerConnection.current.close();
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

  // --- 6. CHALLENGE LOGIC & SCREEN FLASH ---
  
  const triggerScreenFlashCheck = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    
    // 1. Measure Baseline Brightness (Before Flash)
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(videoRef.current, 0, 0);
    const preData = ctx.getImageData(0, 0, 640, 480).data;
    const preBrightness = calculateBrightness(preData);
    
    console.log(`[PPAH] Pre-Flash Brightness: ${preBrightness.toFixed(2)}`);

    // 2. TRIGGER THE FLASH (Visual)
    setIsFlashActive(true); 

    // 3. Wait 150ms (Allow light to travel and camera to capture)
    await new Promise(r => setTimeout(r, 150));

    // 4. Measure "During Flash" Brightness
    ctx.drawImage(videoRef.current, 0, 0);
    const postData = ctx.getImageData(0, 0, 640, 480).data;
    const postBrightness = calculateBrightness(postData);

    // 5. REMOVE FLASH
    setIsFlashActive(false);

    console.log(`[PPAH] Post-Flash Brightness: ${postBrightness.toFixed(2)}`);

    // 6. PHYSICS CHECK
    // A real face close to a screen MUST get brighter
    // A Virtual Camera will have 0.0 change.
    const delta = postBrightness - preBrightness;
    
    if (delta < 2.0) {
        console.warn(`[PPAH] PHYSICS FAIL: Face did not reflect screen light. Delta: ${delta}`);
        handleSecurityEvent("Liveness Fail (Physics)", 20); // Big penalty
    } else {
        console.log("[PPAH] Physics Pass: Light reflection detected.");
        // Reward the user
        setTrustScore(prev => Math.min(100, prev + 5));
    }
  };

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

  // --- 7. MONITORING LOOP (HARDENED) ---
  const startMonitoring = (activeSid: string) => {
    let seg = 1;
    isMonitoringActive.current = true;

    const loop = async () => {
        if (!isMonitoringActive.current) return; 

        const startTime = Date.now();
        const video = videoRef.current;
        const canvas = canvasRef.current;

        // --- HEURISTIC VARIABLES ---
        let aggressiveMode = false;

        if (video && canvas && landmarkerRef.current && video.readyState >= 2) {
            try {
                // 1. Scene & Brightness Analysis (The Swap Detector)
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                    ctx.drawImage(video, 0, 0);
                    const imgData = ctx.getImageData(0,0,640,480);
                    
                    // A. Calculate Brightness & Color Entropy
                    const currentBrightness = calculateBrightness(imgData.data);
                    const currentColorEntropy = calculateColorEntropy(imgData.data);
                    
                    // Update brightness history for environmental stability tracking
                    brightnessHistoryRef.current.push(currentBrightness);
                    if (brightnessHistoryRef.current.length > 10) {
                      brightnessHistoryRef.current.shift();
                    }
                    
                    // B. Combined Heuristics for Scene Shift Detection
                    if (previousBrightnessRef.current !== null && previousColorEntropyRef.current !== null) {
                        const brightnessDelta = Math.abs(currentBrightness - previousBrightnessRef.current);
                        const entropyDelta = Math.abs(currentColorEntropy - previousColorEntropyRef.current);
                        
                        // Calculate environmental stability (variance over last 10 samples)
                        let brightnessVariance = 0;
                        if (brightnessHistoryRef.current.length >= 5) {
                          const mean = brightnessHistoryRef.current.reduce((a, b) => a + b, 0) / brightnessHistoryRef.current.length;
                          brightnessVariance = brightnessHistoryRef.current.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / brightnessHistoryRef.current.length;
                        }
                        
                        // Dynamic threshold based on environmental stability
                        // More stable environment = stricter threshold
                        const isEnvironmentStable = brightnessVariance < 50;
                        const brightnessThreshold = isEnvironmentStable ? 20 : 30; // Increased from fixed 15
                        const entropyThreshold = isEnvironmentStable ? 0.8 : 1.2;
                        
                        // Track environmental stability
                        if (brightnessDelta < 5) {
                          environmentStableCountRef.current++;
                        } else {
                          environmentStableCountRef.current = 0;
                        }
                        
                        // Scene shift detection with combined heuristics
                        // Requires BOTH brightness AND entropy changes to reduce false positives
                        const timeSinceLastChange = Date.now() - lastBrightnessChangeRef.current;
                        const isLikelyNaturalChange = timeSinceLastChange > 10000 && environmentStableCountRef.current > 5;
                        
                        if (brightnessDelta > brightnessThreshold && 
                            entropyDelta > entropyThreshold && 
                            !challengeActiveRef.current && 
                            !isFlashActive &&
                            !isLikelyNaturalChange) {
                            
                            console.warn(`[PPAH] Scene Shift Detected - Brightness: ${brightnessDelta.toFixed(1)}, Entropy: ${entropyDelta.toFixed(2)}, Variance: ${brightnessVariance.toFixed(1)}`);
                            aggressiveMode = true;
                            lastBrightnessChangeRef.current = Date.now();
                            environmentStableCountRef.current = 0;
                            
                            // Reduced penalty with EMA smoothing
                            handleSecurityEvent("Scene Shift", 8); 
                        } else if (brightnessDelta > brightnessThreshold && isLikelyNaturalChange) {
                            // Log natural environmental change without penalty
                            console.log(`[PPAH] Natural brightness change detected (gradual): ${brightnessDelta.toFixed(1)}`);
                        }
                    }
                    
                    previousBrightnessRef.current = currentBrightness;
                    previousColorEntropyRef.current = currentColorEntropy;
                    colorEntropyRef.current = currentColorEntropy;

                    // 2. Worker Logic (Updated for Dynamic Calibration)
                    if (seg === 1) workerRef.current?.postMessage({ type: 'CALIBRATE', imageData: imgData }); 
                    else if (!challengeActiveRef.current) {
                        workerRef.current?.postMessage({ 
                            type: 'ANALYZE_FRAME', 
                            imageData: imgData, 
                            anchorBiometric: anchorBiometricRef.current 
                        });
                    }

                    // 3. Cryptographic Hashing with improved error handling
                    try {
                        const hashBuf = await crypto.subtle.digest('SHA-256', imgData.data);
                        const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
                        
                        // If Aggressive Mode, we tag the signature
                        const sig = await signPacket(activeSid, seg, hashHex, trustScoreRef.current);
                        
                        try {
                             await fetch(`${getBackendUrl()}/api/verify-hash`, {
                                method: 'POST', headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({ 
                                    session_id: activeSid, 
                                    segment_id: seg, 
                                    hash: hashHex, 
                                    trust_score: trustScoreRef.current, 
                                    signature: sig 
                                })
                            });
                            seg++;
                        } catch (netErr) { 
                            console.warn(`[PPAH Network] Hash verification failed for segment ${seg}:`, netErr);
                            // Fallback: Continue without terminating session for transient network issues
                        }
                    } catch (hashErr) {
                        console.error(`[PPAH Hash Error] Failed to compute hash for segment ${seg}:`, hashErr);
                        // Fallback: Skip this frame and continue monitoring
                    }
                }

                // 4. MediaPipe Face Check (Existing Logic)
                const results = landmarkerRef.current.detectForVideo(video, performance.now());
                if (results.faceLandmarks.length > 0) {
                    setFaceDetected(true);
                    noFaceCounter.current = 0; 
                    if (!challengeActiveRef.current && trustScoreRef.current > 0 && trustScoreRef.current < 100) {
                         // Apply EMA smoothing to trust score recovery
                         const recoveryAmount = aggressiveMode ? 1 : 3; // Reduced from 1:5 for gradual recovery
                         setTrustScore(prev => {
                            const targetScore = Math.min(100, prev + recoveryAmount);
                            const smoothedScore = Math.round(
                              trustScoreEMA.current * (1 - EMA_ALPHA) + targetScore * EMA_ALPHA
                            );
                            trustScoreEMA.current = smoothedScore;
                            return Math.min(100, smoothedScore);
                         });
                    }
                } else {
                    setFaceDetected(false);
                    noFaceCounter.current += 1;
                    if (noFaceCounter.current > 10) handleSecurityEvent("No Face", 2);
                }

            } catch (loopErr) {
                console.error(`[PPAH Monitoring Error] Frame processing failed:`, {
                    error: loopErr,
                    segment: seg,
                    trustScore: trustScoreRef.current,
                    faceDetected,
                    timestamp: new Date().toISOString()
                });
                // Fallback: Continue monitoring despite error
            }
        }

        // --- RANDOM PHYSICS CHECK (Step 3: Screen Flash) ---
        // approx every 300 cycles (~30s), if face is present and no challenge active
        if (Math.random() < 0.003 && faceDetected && !challengeActiveRef.current && !isFlashActive) {
            triggerScreenFlashCheck();
        }

        // --- ADAPTIVE TIMING (Weighted Metrics Logic) ---
        // Calculate weighted interval based on multiple factors
        // Base interval: 1000ms
        // Factors: Trust Score (40%), Network Stability (30%), Scene Stability (30%)
        let nextDelay = 1000;
        
        // Trust score factor (40% weight)
        const trustFactor = trustScoreRef.current / 100;
        
        // Network stability factor (30% weight)
        const networkFactor = iceStatus === 'Connected' ? 1.0 : 0.3;
        
        // Environmental stability factor (30% weight)
        const envStability = environmentStableCountRef.current >= 5 ? 1.0 : 0.5;
        
        // Combined weighted score (0-1 range)
        const combinedScore = (trustFactor * 0.4) + (networkFactor * 0.3) + (envStability * 0.3);
        
        // Map combined score to interval range
        // High score (>0.8): 1000ms (normal)
        // Medium score (0.5-0.8): 500ms (moderate)
        // Low score (<0.5): 300ms (aggressive but not extreme)
        // Scene shift detected: 250ms (most aggressive)
        if (aggressiveMode) {
            nextDelay = 250; // Scene shift detected
            console.log(`[PPAH Adaptive Hash] Aggressive mode active, interval: ${nextDelay}ms`);
        } else if (combinedScore > 0.8) {
            nextDelay = 1000; // Normal monitoring
        } else if (combinedScore > 0.5) {
            nextDelay = 500; // Moderate monitoring
            console.log(`[PPAH Adaptive Hash] Moderate monitoring, combined score: ${combinedScore.toFixed(2)}, interval: ${nextDelay}ms`);
        } else {
            nextDelay = 300; // Heightened monitoring
            console.log(`[PPAH Adaptive Hash] Heightened monitoring, combined score: ${combinedScore.toFixed(2)}, interval: ${nextDelay}ms`);
        }

        const processingTime = Date.now() - startTime;
        const actualDelay = Math.max(0, nextDelay - processingTime);
        
        monitoringRef.current = setTimeout(loop, actualDelay);
    };

    loop(); 
  };

  // --- AUTH & INIT (WITH BLOCKER) ---
  const initializeCamera = async () => {
    setStatusMessage('Init Camera...');
    try {
      // 1. VIRTUAL CAMERA BLOCKADE
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      
      for (const device of videoInputs) {
          const label = device.label.toLowerCase();
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

      // 3. DOUBLE CHECK TRACK
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
                   {(remoteTrustScore !== null || isRemoteConnected) && (
                     <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full backdrop-blur-md border ${(remoteTrustScore || 100) > 80 ? 'bg-green-900/40 border-green-500/30 text-green-400' : 'bg-red-900/40 border-red-500/30 text-red-400'}`}>
                        <Shield size={12} fill="currentColor" />
                        <span className="text-xs font-bold">{remoteTrustScore !== null ? remoteTrustScore : 'Syncing...'}%</span>
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

      {/* SCREEN FLASH OVERLAY (For Passive Liveness) */}
      <div 
        className={`fixed inset-0 bg-white z-[100] pointer-events-none transition-opacity duration-75 ${
          isFlashActive ? 'opacity-90' : 'opacity-0'
        }`}
      />

      {/* Hidden Analysis Canvas */}
      <canvas ref={canvasRef} width={640} height={480} className="hidden" />
    </div>
  );
};

// --- HELPER: BRIGHTNESS CALCULATOR (Updated for Performance) ---
const calculateBrightness = (data: Uint8ClampedArray) => {
  let sum = 0;
  let samples = 0;
  for (let i = 0; i < data.length; i += 40) { // stride of 40 (10 pixels) for performance
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Perceived brightness formula
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
    samples++;
  }
  return sum / samples; // Returns 0-255
};

// --- HELPER: COLOR ENTROPY CALCULATOR ---
const calculateColorEntropy = (data: Uint8ClampedArray) => {
  const histogram = new Array(256).fill(0);
  let samples = 0;
  
  // Build histogram of brightness values
  for (let i = 0; i < data.length; i += 40) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    histogram[gray]++;
    samples++;
  }
  
  // Calculate Shannon entropy
  let entropy = 0;
  for (let count of histogram) {
    if (count > 0) {
      const p = count / samples;
      entropy -= p * Math.log2(p);
    }
  }
  
  return entropy; // Returns 0-8 (bits)
};

export default PPAHVerification;
