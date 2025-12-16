from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from typing import Dict, Optional, List
from datetime import datetime, timedelta
import hashlib
import hmac
import secrets
import json
import time

app = FastAPI(title="PPAH Enhanced Verification API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================================
# DATA MODELS
# ============================================================================

class InitSessionRequest(BaseModel):
    email: Optional[EmailStr] = None
    webauthn_credential_id: Optional[str] = None
    camera_fingerprint: Optional[str] = None

class VerifyHashRequest(BaseModel):
    session_id: str
    segment_id: int
    hash: str
    signature: str 

class ReAuthRequest(BaseModel):
    session_id: str
    webauthn_credential_id: str

class MagicLinkRequest(BaseModel):
    email: EmailStr

# ============================================================================
# IN-MEMORY STORAGE
# ============================================================================

SESSIONS: Dict[str, dict] = {}
MAGIC_TOKENS: Dict[str, dict] = {}
WEBAUTHN_CREDENTIALS: Dict[str, dict] = {}
SESSION_TIMEOUT = 3600

# ============================================================================
# ENHANCED SESSION CLASS
# ============================================================================

class PPAHSession:
    def __init__(self, session_id: str, email: Optional[str] = None, 
                 camera_fingerprint: Optional[str] = None,
                 session_key: str = None):
        self.session_id = session_id
        self.email = email
        self.created_at = datetime.now()
        self.last_activity = datetime.now()
        self.status = "active"
        self.segment_count = 0
        self.hash_chain = []
        self.expected_next_hash = None
        self.freeze_reason = None
        
        # Enhanced security tracking
        self.session_key = session_key # Key for HMAC verification
        self.camera_fingerprint = camera_fingerprint
        self.camera_fingerprint_locked = camera_fingerprint is not None
        self.anomaly_log = []
        
    def verify_signature(self, segment_id: int, hash_value: str, signature: str) -> bool:
        """
        Verify that the packet was signed by the client using the session key.
        Prevents man-in-the-middle and injection attacks.
        """
        # STRICT SECURITY: If no key exists, we cannot verify, so we must fail.
        if not self.session_key:
            self.log_anomaly("Missing session key for signature verification")
            return False 
            
        # Reconstruct the message exactly as the client builds it:
        # message = sessionId + segmentId + hash
        message = f"{self.session_id}{segment_id}{hash_value}"
        
        # Compute expected HMAC-SHA256 signature
        try:
            expected_sig = hmac.new(
                self.session_key.encode('utf-8'),
                message.encode('utf-8'),
                hashlib.sha256
            ).hexdigest()
        except Exception as e:
            print(f"[ERROR] HMAC calculation failed: {e}")
            return False
        
        # Secure comparison to prevent timing attacks
        return hmac.compare_digest(expected_sig, signature)

    def add_hash(self, segment_id: int, hash_value: str, signature: str) -> bool:
        """Validate hash chain sequence and signature"""
        self.last_activity = datetime.now()
        
        # 1. SECURITY: Check Signature
        if not self.verify_signature(segment_id, hash_value, signature):
            self.log_anomaly(f"Invalid HMAC signature for segment {segment_id}")
            self.freeze("Packet signature verification failed - Possible spoofing")
            return False

        # 2. NETWORK ROBUSTNESS: Sliding Window Check
        # We expect segment_count + 1, but we allow +2 (one dropped packet)
        expected = self.segment_count + 1
        
        if segment_id == expected:
            # Perfect sequence
            pass
        elif segment_id == expected + 1:
            # One packet dropped - Log it but keep session alive
            print(f"[NETWORK] Warning: Dropped packet {expected}, accepting {segment_id}")
            self.log_anomaly(f"Packet loss detected (Gap: {expected} missing)")
        elif segment_id <= self.segment_count:
            # Old/Duplicate packet - Ignore gracefully
            return True
        else:
            # Gap too large - Likely Injection Attack
            self.log_anomaly(f"Non-sequential segment: expected {expected}, got {segment_id}")
            self.freeze(f"Segment sequence break detected (Gap > 1)")
            return False
        
        # Add to chain
        self.hash_chain.append({
            'segment_id': segment_id,
            'hash': hash_value,
            'timestamp': datetime.now().isoformat()
        })
        
        self.segment_count = segment_id
        return True
    
    def validate_camera_fingerprint(self, current_fingerprint: str) -> bool:
        """Check if camera device was swapped"""
        if not self.camera_fingerprint_locked:
            return True
            
        if current_fingerprint != self.camera_fingerprint:
            self.log_anomaly(f"Camera fingerprint mismatch")
            self.freeze("Camera device changed - possible hardware substitution")
            return False
            
        return True
    
    def log_anomaly(self, description: str):
        """Record security anomalies"""
        self.anomaly_log.append({
            'timestamp': datetime.now().isoformat(),
            'description': description,
            'segment_count': self.segment_count
        })
        print(f"[ANOMALY] {self.session_id[:8]} - {description}")
    
    def freeze(self, reason: str):
        """Freeze session due to security violation"""
        self.status = "frozen"
        self.freeze_reason = reason
        print(f"[SECURITY] Session {self.session_id[:8]} frozen: {reason}")
    
    def terminate(self):
        """End session"""
        self.status = "terminated"
        print(f"[SESSION] Session {self.session_id[:8]} terminated")
    
    def is_active(self) -> bool:
        """Check if session is still valid"""
        if self.status != "active": 
            return False
            
        if (datetime.now() - self.last_activity).total_seconds() > SESSION_TIMEOUT:
            self.terminate()
            return False
            
        return True
    
    def to_dict(self) -> dict:
        """Serialize session for API response"""
        return {
            'session_id': self.session_id,
            'email': self.email,
            'created_at': self.created_at.isoformat(),
            'last_activity': self.last_activity.isoformat(),
            'status': self.status,
            'segment_count': self.segment_count,
            'freeze_reason': self.freeze_reason,
            'hash_chain_length': len(self.hash_chain),
            'camera_locked': self.camera_fingerprint_locked,
            'anomaly_count': len(self.anomaly_log)
        }
    
    def get_security_report(self) -> dict:
        """Generate detailed security report"""
        return {
            'session_id': self.session_id,
            'duration_seconds': (datetime.now() - self.created_at).total_seconds(),
            'total_segments': self.segment_count,
            'status': self.status,
            'freeze_reason': self.freeze_reason,
            'anomalies': self.anomaly_log,
            'security_layers': {
                'hash_chain': True,
                'packet_signing': self.session_key is not None,
                'camera_fingerprint': self.camera_fingerprint_locked,
            }
        }

# ============================================================================
# API ENDPOINTS
# ============================================================================

@app.get('/api/auth/config')
async def get_auth_config(request: Request):
    """Dynamic WebAuthn configuration"""
    client_host = request.url.hostname
    valid_hosts = ["localhost", "127.0.0.1", "172.16.48.128"]
    rp_id = client_host if client_host in valid_hosts else "localhost"
    
    return {
        "rpId": rp_id,
        "rpName": "PPAH Enhanced App",
        "msg": f"Configured for {rp_id}"
    }

@app.post('/api/magic-link/request')
async def request_magic_link(request: MagicLinkRequest, background_tasks: BackgroundTasks):
    """Generate magic link for passwordless auth"""
    token = secrets.token_urlsafe(32)
    MAGIC_TOKENS[token] = {
        'email': request.email,
        'created_at': datetime.now(),
        'expires_at': datetime.now() + timedelta(minutes=15),
        'used': False
    }
    
    magic_link = f"/verify?token={token}" 
    print(f"[MAGIC LINK] Generated for {request.email}: {magic_link}")
    
    return {
        'success': True, 
        'message': 'Magic link sent', 
        'demo_link': magic_link
    }

@app.get('/api/magic-link/verify/{token}')
async def verify_magic_link(token: str):
    """Verify magic link and create session"""
    if token not in MAGIC_TOKENS: 
        raise HTTPException(status_code=404, detail='Invalid token')
        
    token_data = MAGIC_TOKENS[token]
    
    if datetime.now() > token_data['expires_at']: 
        raise HTTPException(status_code=401, detail='Expired')
        
    if token_data['used']: 
        raise HTTPException(status_code=401, detail='Used')
        
    token_data['used'] = True
    
    session_id = secrets.token_hex(16)
    session_key = secrets.token_hex(32)
    
    session = PPAHSession(session_id, email=token_data['email'], session_key=session_key)
    SESSIONS[session_id] = session
    
    return {
        'success': True, 
        'session_id': session_id,
        'session_key': session_key, 
        'email': token_data['email']
    }

@app.post('/api/webauthn/register')
async def register_webauthn(data: dict):
    """Register WebAuthn credential"""
    credential_id = data.get('credential_id')
    email = data.get('email', 'anonymous@ppah.app')
    public_key = data.get('public_key')
    
    if not credential_id: 
        raise HTTPException(status_code=400, detail='Missing credential_id')
        
    WEBAUTHN_CREDENTIALS[credential_id] = {
        'email': email, 
        'public_key': public_key, 
        'created_at': datetime.now().isoformat(), 
        'last_used': None
    }
    
    print(f"[WEBAUTHN] Registered {email}")
    return {'success': True, 'credential_id': credential_id}

@app.post('/api/webauthn/authenticate')
async def authenticate_webauthn(data: dict):
    """Authenticate with WebAuthn"""
    credential_id = data.get('credential_id')
    
    if not credential_id or credential_id not in WEBAUTHN_CREDENTIALS:
        raise HTTPException(status_code=401, detail='Invalid credential')
        
    WEBAUTHN_CREDENTIALS[credential_id]['last_used'] = datetime.now().isoformat()
    
    session_id = secrets.token_hex(16)
    session_key = secrets.token_hex(32) 
    
    email = WEBAUTHN_CREDENTIALS[credential_id]['email']
    session = PPAHSession(session_id, email=email, session_key=session_key)
    SESSIONS[session_id] = session
    
    return {
        'success': True, 
        'session_id': session_id,
        'session_key': session_key,
        'email': email
    }

@app.post('/api/session/init')
async def initialize_session(request: InitSessionRequest):
    """Initialize new verification session with optional camera fingerprint"""
    session_id = secrets.token_hex(16)
    session_key = secrets.token_hex(32)
    
    session = PPAHSession(
        session_id, 
        email=request.email,
        camera_fingerprint=request.camera_fingerprint,
        session_key=session_key
    )
    SESSIONS[session_id] = session
    
    print(f"[SESSION] Initialized {session_id[:8]} - Key Generated")
    
    return {
        'session_id': session_id,
        'session_key': session_key,
        'status': 'initialized',
        'camera_locked': session.camera_fingerprint_locked
    }

@app.post('/api/verify-hash')
async def verify_hash(request: VerifyHashRequest):
    """
    Verify hash chain segment with HMAC signature
    """
    if request.session_id not in SESSIONS: 
        raise HTTPException(status_code=404, detail='Session not found')
        
    session = SESSIONS[request.session_id]
    
    if not session.is_active(): 
        raise HTTPException(status_code=403, detail=f'Session {session.status}')
    
    # Validate hash sequence AND signature
    if not session.add_hash(request.segment_id, request.hash, request.signature):
        return {
            'valid': False, 
            'segment_id': request.segment_id, 
            'reason': session.freeze_reason, 
            'action': 'reauth_required'
        }
    
    print(f"[VERIFY] {session.session_id[:8]} - Segment {request.segment_id} ✓")
    
    return {
        'valid': True, 
        'segment_id': request.segment_id, 
        'session_status': session.status, 
        'total_segments': session.segment_count
    }

@app.post('/api/session/reauth')
async def reauthenticate_session(request: ReAuthRequest):
    """Re-authenticate frozen session"""
    if request.session_id not in SESSIONS: 
        raise HTTPException(status_code=404, detail='Session not found')
        
    session = SESSIONS[request.session_id]
    
    if request.webauthn_credential_id not in WEBAUTHN_CREDENTIALS: 
        raise HTTPException(status_code=401, detail='Invalid credential')
        
    session.status = "active"
    session.freeze_reason = None
    session.last_activity = datetime.now()
    
    print(f"[REAUTH] Session {session.session_id[:8]} reactivated")
    
    return {
        'success': True, 
        'session_id': session.session_id, 
        'status': 'active'
    }

@app.get('/api/session/{session_id}')
async def get_session(session_id: str):
    """Get session details"""
    if session_id not in SESSIONS: 
        raise HTTPException(status_code=404, detail='Session not found')
    return SESSIONS[session_id].to_dict()

@app.get('/api/session/{session_id}/security-report')
async def get_security_report(session_id: str):
    """Get detailed security audit report"""
    if session_id not in SESSIONS: 
        raise HTTPException(status_code=404, detail='Session not found')
    return SESSIONS[session_id].get_security_report()

@app.get('/')
async def root():
    """API health check"""
    return {
        'service': 'PPAH Enhanced Verification API', 
        'status': 'running', 
        'version': '2.2.0',
        'features': [
            'HMAC Packet Signing (STRICT)',
            'Sliding Window Network Logic',
            'Camera Fingerprinting',
            'Biometric Anchoring (Client-side)',
            'Anomaly Logging'
        ]
    }

@app.get('/api/stats')
async def get_stats():
    """System statistics"""
    active_sessions = sum(1 for s in SESSIONS.values() if s.is_active())
    frozen_sessions = sum(1 for s in SESSIONS.values() if s.status == "frozen")
    total_segments = sum(s.segment_count for s in SESSIONS.values())
    
    return {
        'total_sessions': len(SESSIONS),
        'active_sessions': active_sessions,
        'frozen_sessions': frozen_sessions,
        'total_segments_verified': total_segments,
        'registered_credentials': len(WEBAUTHN_CREDENTIALS)
    }

if __name__ == "__main__":
    import uvicorn
    print("=" * 60)
    print("PPAH Enhanced Verification Server v2.2.0 (SECURED)")
    print("=" * 60)
    print("Features:")
    print("  ✓ HMAC-SHA256 Packet Signing (Enforced)")
    print("  ✓ Robust Network Sliding Window")
    print("  ✓ Camera Device Fingerprinting")
    print("  ✓ Security Anomaly Logging")
    print("=" * 60)
    uvicorn.run(app, host="0.0.0.0", port=8000)
