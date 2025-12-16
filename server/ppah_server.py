from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from typing import Dict, Optional, List
from datetime import datetime, timedelta
import hashlib
import hmac
import secrets
import json
import sqlite3  # <--- Persistence
import os

app = FastAPI(title="PPAH Enhanced Verification API")

# Allow all origins (for local dev), but in production restrict this!
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================================
# DATABASE SETUP (SQLite)
# ============================================================================

DB_NAME = "ppah_enterprise.db"

def init_db():
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    # 1. Sessions Table
    c.execute('''CREATE TABLE IF NOT EXISTS sessions 
                 (session_id TEXT PRIMARY KEY, 
                  data TEXT, 
                  updated_at TIMESTAMP)''')
    
    # 2. Magic Links Table
    c.execute('''CREATE TABLE IF NOT EXISTS magic_links 
                 (token TEXT PRIMARY KEY, 
                  data TEXT, 
                  expires_at TIMESTAMP)''')
                  
    # 3. WebAuthn Credentials
    c.execute('''CREATE TABLE IF NOT EXISTS credentials 
                 (cred_id TEXT PRIMARY KEY, 
                  data TEXT)''')
    conn.commit()
    conn.close()

init_db()

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
# SESSION LOGIC (With DB Persistence)
# ============================================================================

SESSION_TIMEOUT = 3600

class PPAHSession:
    def __init__(self, session_id: str, email: Optional[str] = None, 
                 camera_fingerprint: Optional[str] = None,
                 session_key: str = None,
                 restore_data: dict = None):
        
        if restore_data:
            # Rehydrate from DB
            self.session_id = restore_data['session_id']
            self.email = restore_data['email']
            self.created_at = datetime.fromisoformat(restore_data['created_at'])
            self.last_activity = datetime.fromisoformat(restore_data['last_activity'])
            self.status = restore_data['status']
            self.segment_count = restore_data['segment_count']
            self.hash_chain = restore_data['hash_chain']
            self.freeze_reason = restore_data['freeze_reason']
            self.session_key = restore_data['session_key']
            self.camera_fingerprint = restore_data['camera_fingerprint']
            self.camera_fingerprint_locked = restore_data['camera_locked']
            self.anomaly_log = restore_data['anomaly_log']
        else:
            # New Session
            self.session_id = session_id
            self.email = email
            self.created_at = datetime.now()
            self.last_activity = datetime.now()
            self.status = "active"
            self.segment_count = 0
            self.hash_chain = []
            self.freeze_reason = None
            self.session_key = session_key 
            self.camera_fingerprint = camera_fingerprint
            self.camera_fingerprint_locked = camera_fingerprint is not None
            self.anomaly_log = []
        
    def verify_signature(self, segment_id: int, hash_value: str, signature: str) -> bool:
        if not self.session_key:
            self.log_anomaly("Missing session key for signature verification")
            return False 
        message = f"{self.session_id}{segment_id}{hash_value}"
        try:
            expected_sig = hmac.new(
                self.session_key.encode('utf-8'),
                message.encode('utf-8'),
                hashlib.sha256
            ).hexdigest()
        except Exception:
            return False
        return hmac.compare_digest(expected_sig, signature)

    def add_hash(self, segment_id: int, hash_value: str, signature: str) -> bool:
        self.last_activity = datetime.now()
        
        # 1. Signature Check
        if not self.verify_signature(segment_id, hash_value, signature):
            self.log_anomaly(f"Invalid HMAC signature for segment {segment_id}")
            self.freeze("Packet signature verification failed - Possible spoofing")
            return False

        # 2. Sliding Window
        expected = self.segment_count + 1
        if segment_id == expected:
            pass
        elif segment_id == expected + 1:
            self.log_anomaly(f"Packet loss detected (Gap: {expected} missing)")
        elif segment_id <= self.segment_count:
            return True
        else:
            self.log_anomaly(f"Non-sequential segment: expected {expected}, got {segment_id}")
            self.freeze(f"Segment sequence break detected (Gap > 1)")
            return False
        
        self.hash_chain.append({
            'segment_id': segment_id,
            'hash': hash_value,
            'timestamp': datetime.now().isoformat()
        })
        self.segment_count = segment_id
        return True
    
    def log_anomaly(self, description: str):
        self.anomaly_log.append({
            'timestamp': datetime.now().isoformat(),
            'description': description,
            'segment_count': self.segment_count
        })
        print(f"[ANOMALY] {self.session_id[:8]} - {description}")
    
    def freeze(self, reason: str):
        self.status = "frozen"
        self.freeze_reason = reason
        print(f"[SECURITY] Session {self.session_id[:8]} frozen: {reason}")
    
    def is_active(self) -> bool:
        if self.status != "active": return False
        if (datetime.now() - self.last_activity).total_seconds() > SESSION_TIMEOUT:
            self.status = "terminated"
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
            'hash_chain': self.hash_chain,
            'freeze_reason': self.freeze_reason,
            'session_key': self.session_key,
            'camera_fingerprint': self.camera_fingerprint,
            'camera_locked': self.camera_fingerprint_locked,
            'anomaly_log': self.anomaly_log
        }
    
    def get_security_report(self) -> dict:
        return {
            'session_id': self.session_id,
            'duration_seconds': (datetime.now() - self.created_at).total_seconds(),
            'total_segments': self.segment_count,
            'status': self.status,
            'freeze_reason': self.freeze_reason,
            'anomalies': self.anomaly_log,
            'security_layers': {
                'hash_chain': True,
                'packet_signing': True,
                'camera_fingerprint': self.camera_fingerprint_locked,
                'persistence': 'SQLite'
            }
        }

# ============================================================================
# DB HELPERS
# ============================================================================

def save_session(session: PPAHSession):
    try:
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute('INSERT OR REPLACE INTO sessions (session_id, data, updated_at) VALUES (?, ?, ?)',
                  (session.session_id, json.dumps(session.to_dict()), datetime.now()))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[DB ERROR] Save failed: {e}")

def load_session(session_id: str) -> Optional[PPAHSession]:
    try:
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute('SELECT data FROM sessions WHERE session_id = ?', (session_id,))
        row = c.fetchone()
        conn.close()
        if row:
            return PPAHSession(session_id, restore_data=json.loads(row[0]))
    except Exception as e:
        print(f"[DB ERROR] Load failed: {e}")
    return None

# ============================================================================
# API ENDPOINTS
# ============================================================================

@app.get('/api/auth/config')
async def get_auth_config(request: Request):
    client_host = request.url.hostname
    rp_id = client_host if client_host not in ["localhost", "127.0.0.1"] else "localhost"
    return {"rpId": rp_id, "rpName": "PPAH Enterprise", "msg": f"Secure Config for {rp_id}"}

@app.post('/api/session/init')
async def initialize_session(request: InitSessionRequest):
    session_id = secrets.token_hex(16)
    session_key = secrets.token_hex(32)
    
    session = PPAHSession(
        session_id, 
        email=request.email,
        camera_fingerprint=request.camera_fingerprint,
        session_key=session_key
    )
    save_session(session) # Persist immediately
    
    print(f"[SESSION] Initialized {session_id[:8]}")
    return {
        'session_id': session_id,
        'session_key': session_key,
        'status': 'initialized',
        'camera_locked': session.camera_fingerprint_locked
    }

@app.post('/api/verify-hash')
async def verify_hash(request: VerifyHashRequest):
    session = load_session(request.session_id)
    if not session: 
        raise HTTPException(status_code=404, detail='Session not found')
        
    if not session.is_active(): 
        raise HTTPException(status_code=403, detail=f'Session {session.status}')
    
    valid = session.add_hash(request.segment_id, request.hash, request.signature)
    save_session(session) # Update DB
    
    if not valid:
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

@app.get('/api/session/{session_id}/security-report')
async def get_security_report(session_id: str):
    session = load_session(session_id)
    if not session: 
        raise HTTPException(status_code=404, detail='Session not found')
    return session.get_security_report()

@app.get('/')
async def root():
    return {
        'service': 'PPAH Enterprise API', 
        'status': 'running', 
        'version': '3.0.0',
        'storage': 'SQLite'
    }

if __name__ == "__main__":
    import uvicorn
    # INSTRUCTIONS FOR HTTPS:
    # Generate certs: openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
    # Run: uvicorn ppah_server:app --host 0.0.0.0 --port 8000 --ssl-keyfile key.pem --ssl-certfile cert.pem
    print("WARNING: Run with SSL in production to protect session keys!")
    uvicorn.run(app, host="0.0.0.0", port=8000)
