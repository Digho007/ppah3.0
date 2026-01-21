from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, Body, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Dict, Optional, List, Any
from datetime import datetime
import hashlib
import hmac
import secrets
import json
import sqlite3
import logging

# --- LOGGING SETUP ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("PPAH_Server")

from webauthn import (
    generate_registration_options,
    verify_registration_response,
    options_to_json,
    generate_authentication_options,
    verify_authentication_response,
)
from webauthn.helpers import (
    parse_registration_credential_json,
    parse_authentication_credential_json
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    UserVerificationRequirement,
    PublicKeyCredentialDescriptor,
    PublicKeyCredentialType,
)

app = FastAPI(title="PPAH Enhanced Verification API - SECURED")

# --- CONFIGURATION ---
NGROK_DOMAIN = "jim-peaceable-inconsequently.ngrok-free.dev"

if NGROK_DOMAIN:
    RP_ID = NGROK_DOMAIN
    RP_NAME = "PPAH Remote"
    ORIGIN = f"https://{NGROK_DOMAIN}" 
else:
    RP_ID = "localhost"
    RP_NAME = "PPAH Local"
    ORIGIN = "http://localhost:3000"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_NAME = "ppah_enterprise.db"

# ==========================================
# MODULE 1: DATABASE MANAGER
# ==========================================
class DatabaseManager:
    @staticmethod
    def init_db():
        with sqlite3.connect(DB_NAME) as conn:
            c = conn.cursor()
            c.execute('''CREATE TABLE IF NOT EXISTS sessions 
                         (session_id TEXT PRIMARY KEY, data TEXT, updated_at TIMESTAMP)''')
            c.execute('''CREATE TABLE IF NOT EXISTS credentials
                         (id BLOB PRIMARY KEY, user_email TEXT, public_key BLOB, sign_count INTEGER)''')
            conn.commit()

    @staticmethod
    def get_credential(email: str):
        with sqlite3.connect(DB_NAME) as conn:
            c = conn.cursor()
            c.execute("SELECT id FROM credentials WHERE user_email = ?", (email,))
            rows = c.fetchall()
            return rows

    @staticmethod
    def get_credential_by_id(cred_id: bytes):
        with sqlite3.connect(DB_NAME) as conn:
            c = conn.cursor()
            c.execute("SELECT public_key, sign_count FROM credentials WHERE id = ?", (cred_id,))
            return c.fetchone()

    @staticmethod
    def save_credential(cred_id, email, public_key, sign_count):
        with sqlite3.connect(DB_NAME) as conn:
            c = conn.cursor()
            c.execute("INSERT OR REPLACE INTO credentials (id, user_email, public_key, sign_count) VALUES (?, ?, ?, ?)",
                      (cred_id, email, public_key, sign_count))
            conn.commit()
    
    @staticmethod
    def update_sign_count(new_count, cred_id):
        with sqlite3.connect(DB_NAME) as conn:
            conn.execute("UPDATE credentials SET sign_count = ? WHERE id = ?", (new_count, cred_id))
            conn.commit()

DatabaseManager.init_db()


# ==========================================
# MODULE 2: SIGNALING MANAGER
# ==========================================
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, room_id: str):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = []
        
        if len(self.active_connections[room_id]) >= 2:
            await websocket.send_json({"type": "error", "message": "ROOM_FULL"})
            await websocket.close(code=1008)
            return False

        self.active_connections[room_id].append(websocket)
        return True

    async def disconnect(self, websocket: WebSocket, room_id: str):
        if room_id in self.active_connections:
            if websocket in self.active_connections[room_id]:
                self.active_connections[room_id].remove(websocket)
                await self.broadcast({"type": "peer_left"}, room_id, websocket)
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]

    async def broadcast(self, message: dict, room_id: str, sender: WebSocket):
        if room_id in self.active_connections:
            for connection in self.active_connections[room_id]:
                if connection != sender:
                    try:
                        await connection.send_json(message)
                    except RuntimeError:
                        pass # Handle disconnected clients gracefully

manager = ConnectionManager()


# ==========================================
# MODULE 3: WEBAUTHN HANDLER (SECURED)
# ==========================================
challenge_store = {} 

class WebAuthnResponse(BaseModel):
    email: str
    response: Dict[str, Any]

@app.post("/api/webauthn/register/options")
async def register_options(data: dict = Body(...)):
    email = data.get("email")
    if not email: raise HTTPException(400, "Email required")
    
    user_id_bytes = hashlib.sha256(email.encode()).digest()
    options = generate_registration_options(
        rp_id=RP_ID, rp_name=RP_NAME, user_id=user_id_bytes, user_name=email,
        authenticator_selection=AuthenticatorSelectionCriteria(user_verification=UserVerificationRequirement.PREFERRED)
    )
    challenge_store[email] = options.challenge
    return json.loads(options_to_json(options))

@app.post("/api/webauthn/register/verify")
async def register_verify(data: WebAuthnResponse):
    try:
        email = data.email
        challenge = challenge_store.get(email)
        if not challenge: raise HTTPException(400, "Challenge expired or not found")

        credential = parse_registration_credential_json(data.response)
        
        # Verify
        verification = verify_registration_response(
            credential=credential, expected_challenge=challenge, expected_origin=ORIGIN, expected_rp_id=RP_ID,
        )
        
        # Save
        DatabaseManager.save_credential(
            verification.credential_id, email, 
            verification.credential_public_key, verification.sign_count
        )
        
        # Cleanup
        del challenge_store[email]
        return {"verified": True}
        
    except Exception as e:
        logger.error(f"Registration Failed: {e}")
        # FIX: Raise exception instead of returning True
        raise HTTPException(status_code=400, detail=f"Registration failed: {str(e)}")

@app.post("/api/webauthn/login/options")
async def login_options(data: dict = Body(...)):
    email = data.get("email")
    rows = DatabaseManager.get_credential(email)
    
    if not rows: raise HTTPException(status_code=404, detail="User not registered")
    
    allow_credentials_list = [PublicKeyCredentialDescriptor(id=row[0], type=PublicKeyCredentialType.PUBLIC_KEY) for row in rows]
    options = generate_authentication_options(
        rp_id=RP_ID, 
        allow_credentials=allow_credentials_list, 
        user_verification=UserVerificationRequirement.PREFERRED
    )
    challenge_store[email] = options.challenge
    return json.loads(options_to_json(options))

@app.post("/api/webauthn/login/verify")
async def login_verify(data: WebAuthnResponse):
    try:
        email = data.email
        challenge = challenge_store.get(email)
        if not challenge: raise HTTPException(400, "Challenge not found")
        
        credential = parse_authentication_credential_json(data.response)
        
        row = DatabaseManager.get_credential_by_id(credential.raw_id)
        if not row: raise HTTPException(status_code=400, detail="Credential not found")
        
        # Verify
        verification = verify_authentication_response(
            credential=credential, expected_challenge=challenge, expected_origin=ORIGIN, expected_rp_id=RP_ID,
            credential_public_key=row[0], credential_current_sign_count=row[1],
        )
        
        # Update Counter
        DatabaseManager.update_sign_count(verification.new_sign_count, credential.raw_id)
        
        del challenge_store[email]
        return {"verified": True, "credential_id": credential.id}
        
    except Exception as e:
        logger.error(f"Login Failed: {e}")
        # FIX: Raise exception instead of returning True
        raise HTTPException(status_code=400, detail="Authentication failed")


# ==========================================
# MODULE 4: SESSION & CRYPTO (SECURED)
# ==========================================
class InitSessionRequest(BaseModel):
    email: str
    webauthn_credential_id: str

class VerifyHashRequest(BaseModel):
    session_id: str
    segment_id: int
    hash: str
    trust_score: int 
    signature: str 

class PPAHSession:
    def __init__(self, session_id: str, email: str, webauthn_id: str, session_key: str):
        self.session_id = session_id
        self.email = email
        self.webauthn_id = webauthn_id
        self.session_key = session_key
        self.created_at = datetime.now()
        self.status = "active"
        self.freeze_reason = None
        self.last_trust_score = 100 

    def to_dict(self):
        return self.__dict__.copy()

    @staticmethod
    def load(session_id: str):
        with sqlite3.connect(DB_NAME) as conn:
            row = conn.execute('SELECT data FROM sessions WHERE session_id = ?', (session_id,)).fetchone()
            if row:
                d = json.loads(row[0])
                s = PPAHSession(d['session_id'], d['email'], d['webauthn_id'], d['session_key'])
                s.status = d['status']
                s.freeze_reason = d.get('freeze_reason')
                s.last_trust_score = d.get('last_trust_score', 100) 
                return s
        return None

    def save(self):
        with sqlite3.connect(DB_NAME) as conn:
            c = conn.cursor()
            data = self.to_dict()
            data['created_at'] = str(data['created_at'])
            c.execute('INSERT OR REPLACE INTO sessions (session_id, data, updated_at) VALUES (?, ?, ?)',
                      (self.session_id, json.dumps(data, default=str), datetime.now()))
            conn.commit()

# --- ENDPOINTS ---

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    success = await manager.connect(websocket, room_id)
    if not success: return 
    try:
        while True:
            data = await websocket.receive_json()
            await manager.broadcast(data, room_id, websocket)
    except WebSocketDisconnect:
        await manager.disconnect(websocket, room_id)

@app.post('/api/session/init')
async def initialize_session(request: InitSessionRequest):
    session_id = secrets.token_hex(16)
    session_key = secrets.token_hex(32)
    session = PPAHSession(session_id, request.email, request.webauthn_credential_id, session_key)
    session.save() 
    return {'session_id': session_id, 'session_key': session_key, 'status': 'initialized'}

@app.post('/api/verify-hash')
async def verify_hash(request: VerifyHashRequest):
    session = PPAHSession.load(request.session_id)
    if not session: 
        return {'valid': False, 'session_status': 'terminated'}
    
    # --- FIX: HMAC VALIDATION ---
    # 1. Reconstruct the message exactly as the client did: `${sid}${segId}${hash}${score}`
    message = f"{request.session_id}{request.segment_id}{request.hash}{request.trust_score}".encode('utf-8')
    
    # 2. Key is the session_key (stored as hex string, treated as utf-8 bytes by client encoder)
    key = session.session_key.encode('utf-8')
    
    # 3. Calculate HMAC
    expected_signature = hmac.new(key, message, hashlib.sha256).hexdigest()
    
    # 4. Constant time comparison
    if not hmac.compare_digest(expected_signature, request.signature):
        logger.warning(f"Signature Mismatch for Session {request.session_id}")
        return {'valid': False, 'session_status': 'compromised', 'error': 'Invalid Signature'}

    # Update logic
    session.last_trust_score = request.trust_score
    if request.trust_score < 40:
        session.status = "frozen"
        session.freeze_reason = f"Low Trust Score: {request.trust_score}"
    elif request.trust_score >= 40 and session.status == "frozen":
        session.status = "active"
        session.freeze_reason = None
            
    session.save() 
    return {'valid': True, 'session_status': session.status}

@app.get('/api/session/{session_id}/security-report')
async def get_security_report(session_id: str):
    session = PPAHSession.load(session_id)
    if not session: raise HTTPException(status_code=404)
    return {
        'status': session.status, 
        'score': session.last_trust_score, 
        'freeze_reason': session.freeze_reason
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
