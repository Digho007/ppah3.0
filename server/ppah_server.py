from fastapi import FastAPI, HTTPException, BackgroundTasks, Request  # <--- Added Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from typing import Dict, Optional, List
from datetime import datetime, timedelta
import hashlib
import secrets
import json
import time

app = FastAPI(title="PPAH Verification API")

# ============================================================================
# 1. FIXED CORS (Crucial for VM Access)
# ============================================================================
app.add_middleware(
    CORSMiddleware,
    # Allow "*" lets your Mac (Host) talk to the VM (Guest) without blocking
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ... [DATA MODELS SECTION - KEEP AS IS] ...

class InitSessionRequest(BaseModel):
    email: Optional[EmailStr] = None
    webauthn_credential_id: Optional[str] = None

class VerifyHashRequest(BaseModel):
    session_id: str
    segment_id: int
    hash: str

class ReAuthRequest(BaseModel):
    session_id: str
    webauthn_credential_id: str

class MagicLinkRequest(BaseModel):
    email: EmailStr

# ... [IN-MEMORY STORAGE & SESSION CLASS - KEEP AS IS] ...
# (I am hiding these sections to save space, paste your original code here)

SESSIONS: Dict[str, dict] = {}
MAGIC_TOKENS: Dict[str, dict] = {}
WEBAUTHN_CREDENTIALS: Dict[str, dict] = {}
SESSION_TIMEOUT = 3600 

class PPAHSession:
    # ... (Keep your original PPAHSession class here) ...
    def __init__(self, session_id: str, email: Optional[str] = None):
        self.session_id = session_id
        self.email = email
        self.created_at = datetime.now()
        self.last_activity = datetime.now()
        self.status = "active"
        self.segment_count = 0
        self.hash_chain = []
        self.expected_next_hash = None
        self.freeze_reason = None
        
    def add_hash(self, segment_id: int, hash_value: str) -> bool:
        self.last_activity = datetime.now()
        self.hash_chain.append({
            'segment_id': segment_id,
            'hash': hash_value,
            'timestamp': datetime.now().isoformat()
        })
        if segment_id != self.segment_count + 1:
            self.freeze("Non-sequential segment detected")
            return False
        self.segment_count = segment_id
        return True
    
    def freeze(self, reason: str):
        self.status = "frozen"
        self.freeze_reason = reason
        print(f"[SECURITY] Session {self.session_id[:8]} frozen: {reason}")
    
    def terminate(self):
        self.status = "terminated"
        print(f"[SESSION] Session {self.session_id[:8]} terminated")
    
    def is_active(self) -> bool:
        if self.status != "active": return False
        if (datetime.now() - self.last_activity).total_seconds() > SESSION_TIMEOUT:
            self.terminate()
            return False
        return True
    
    def to_dict(self) -> dict:
        return {
            'session_id': self.session_id,
            'email': self.email,
            'created_at': self.created_at.isoformat(),
            'last_activity': self.last_activity.isoformat(),
            'status': self.status,
            'segment_count': self.segment_count,
            'freeze_reason': self.freeze_reason,
            'hash_chain_length': len(self.hash_chain)
        }

# ============================================================================
# 2. NEW ENDPOINT: Dynamic WebAuthn Config
# ============================================================================
@app.get('/api/auth/config')
async def get_auth_config(request: Request):
    """
    Returns the correct RP_ID based on the hostname accessing the server.
    This solves the 'Invalid Domain' error.
    """
    client_host = request.url.hostname
    
    # Allowed hosts
    valid_hosts = ["localhost", "127.0.0.1", "172.16.48.128"]
    
    # If the host is in our allowed list, use it. Otherwise default to localhost.
    rp_id = client_host if client_host in valid_hosts else "localhost"
    
    return {
        "rpId": rp_id,
        "rpName": "PPAH Secure App",
        "msg": f"Configured for {rp_id}"
    }

# ... [REST OF YOUR ENDPOINTS - KEEP AS IS] ...
# (Magic Link, WebAuthn Register, Authenticate, Session Init, etc.)

@app.post('/api/magic-link/request')
async def request_magic_link(request: MagicLinkRequest, background_tasks: BackgroundTasks):
    token = secrets.token_urlsafe(32)
    MAGIC_TOKENS[token] = {
        'email': request.email,
        'created_at': datetime.now(),
        'expires_at': datetime.now() + timedelta(minutes=15),
        'used': False
    }
    # NOTE: Updated to use relative path so it works on both localhost and VM IP
    magic_link = f"/verify?token={token}" 
    print(f"[MAGIC LINK] Generated for {request.email}: {magic_link}")
    return {'success': True, 'message': 'Magic link sent', 'demo_link': magic_link}

@app.get('/api/magic-link/verify/{token}')
async def verify_magic_link(token: str):
    if token not in MAGIC_TOKENS: raise HTTPException(status_code=404, detail='Invalid token')
    token_data = MAGIC_TOKENS[token]
    if datetime.now() > token_data['expires_at']: raise HTTPException(status_code=401, detail='Expired')
    if token_data['used']: raise HTTPException(status_code=401, detail='Used')
    token_data['used'] = True
    session_id = secrets.token_hex(16)
    session = PPAHSession(session_id, email=token_data['email'])
    SESSIONS[session_id] = session
    return {'success': True, 'session_id': session_id, 'email': token_data['email']}

@app.post('/api/webauthn/register')
async def register_webauthn(data: dict):
    credential_id = data.get('credential_id')
    email = data.get('email', 'anonymous@ppah.app')
    public_key = data.get('public_key')
    if not credential_id: raise HTTPException(status_code=400, detail='Missing credential_id')
    WEBAUTHN_CREDENTIALS[credential_id] = {
        'email': email, 'public_key': public_key, 'created_at': datetime.now().isoformat(), 'last_used': None
    }
    print(f"[WEBAUTHN] Registered {email}")
    return {'success': True, 'credential_id': credential_id}

@app.post('/api/webauthn/authenticate')
async def authenticate_webauthn(data: dict):
    credential_id = data.get('credential_id')
    if not credential_id or credential_id not in WEBAUTHN_CREDENTIALS:
        raise HTTPException(status_code=401, detail='Invalid credential')
    WEBAUTHN_CREDENTIALS[credential_id]['last_used'] = datetime.now().isoformat()
    session_id = secrets.token_hex(16)
    email = WEBAUTHN_CREDENTIALS[credential_id]['email']
    session = PPAHSession(session_id, email=email)
    SESSIONS[session_id] = session
    return {'success': True, 'session_id': session_id, 'email': email}

@app.post('/api/session/init')
async def initialize_session(request: InitSessionRequest):
    session_id = secrets.token_hex(16)
    session = PPAHSession(session_id, email=request.email)
    SESSIONS[session_id] = session
    return {'session_id': session_id, 'status': 'initialized'}

@app.post('/api/verify-hash')
async def verify_hash(request: VerifyHashRequest):
    if request.session_id not in SESSIONS: raise HTTPException(status_code=404, detail='Session not found')
    session = SESSIONS[request.session_id]
    if not session.is_active(): raise HTTPException(status_code=403, detail=f'Session {session.status}')
    if not session.add_hash(request.segment_id, request.hash):
        return {'valid': False, 'segment_id': request.segment_id, 'reason': session.freeze_reason, 'action': 'reauth_required'}
    print(f"[VERIFY] {session.session_id[:8]} - Seg {request.segment_id} ✓")
    return {'valid': True, 'segment_id': request.segment_id, 'session_status': session.status, 'total_segments': session.segment_count}

@app.post('/api/session/reauth')
async def reauthenticate_session(request: ReAuthRequest):
    if request.session_id not in SESSIONS: raise HTTPException(status_code=404, detail='Session not found')
    session = SESSIONS[request.session_id]
    if request.webauthn_credential_id not in WEBAUTHN_CREDENTIALS: raise HTTPException(status_code=401, detail='Invalid credential')
    session.status = "active"
    session.freeze_reason = None
    session.last_activity = datetime.now()
    return {'success': True, 'session_id': session.session_id, 'status': 'active'}

@app.get('/api/session/{session_id}')
async def get_session(session_id: str):
    if session_id not in SESSIONS: raise HTTPException(status_code=404, detail='Session not found')
    return SESSIONS[session_id].to_dict()

@app.get('/')
async def root():
    return {'service': 'PPAH Verification API', 'status': 'running', 'version': '2.0.0'}

# ... [KEEP STARTUP EVENT] ...
