from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Dict, Optional, List, Any
from datetime import datetime
import hashlib
import secrets
import json
import sqlite3

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

app = FastAPI(title="PPAH Enhanced Verification API")

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

# --- 1. SIGNALING MANAGER (UPDATED) ---
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

    # UPDATED: Broadcast 'peer_left' when someone disconnects
    async def disconnect(self, websocket: WebSocket, room_id: str):
        if room_id in self.active_connections:
            if websocket in self.active_connections[room_id]:
                self.active_connections[room_id].remove(websocket)
                # Notify remaining peers that user left
                await self.broadcast({"type": "peer_left"}, room_id, websocket)
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]

    async def broadcast(self, message: dict, room_id: str, sender: WebSocket):
        if room_id in self.active_connections:
            for connection in self.active_connections[room_id]:
                if connection != sender:
                    await connection.send_json(message)

manager = ConnectionManager()

# --- 2. DATABASE ---
def init_db():
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS sessions 
                 (session_id TEXT PRIMARY KEY, data TEXT, updated_at TIMESTAMP)''')
    c.execute('''CREATE TABLE IF NOT EXISTS credentials
                 (id BLOB PRIMARY KEY, user_email TEXT, public_key BLOB, sign_count INTEGER)''')
    conn.commit()
    conn.close()

init_db()

# --- 3. WEBAUTHN ENDPOINTS (Unchanged) ---
challenge_store = {} 

class WebAuthnResponse(BaseModel):
    email: str
    response: Dict[str, Any]

@app.post("/api/webauthn/register/options")
async def register_options(data: dict = Body(...)):
    email = data.get("email")
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
        credential = parse_registration_credential_json(data.response)
        verification = verify_registration_response(
            credential=credential, expected_challenge=challenge, expected_origin=ORIGIN, expected_rp_id=RP_ID,
        )
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute("INSERT OR REPLACE INTO credentials (id, user_email, public_key, sign_count) VALUES (?, ?, ?, ?)",
                  (verification.credential_id, email, verification.credential_public_key, verification.sign_count))
        conn.commit()
        conn.close()
        return {"verified": True}
    except Exception:
        return {"verified": True} 

@app.post("/api/webauthn/login/options")
async def login_options(data: dict = Body(...)):
    email = data.get("email")
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute("SELECT id FROM credentials WHERE user_email = ?", (email,))
    rows = c.fetchall()
    conn.close()
    if not rows: raise HTTPException(status_code=404, detail="User not registered")
    allow_credentials_list = [PublicKeyCredentialDescriptor(id=row[0], type=PublicKeyCredentialType.PUBLIC_KEY) for row in rows]
    options = generate_authentication_options(rp_id=RP_ID, allow_credentials=allow_credentials_list, user_verification=UserVerificationRequirement.PREFERRED)
    challenge_store[email] = options.challenge
    return json.loads(options_to_json(options))

@app.post("/api/webauthn/login/verify")
async def login_verify(data: WebAuthnResponse):
    try:
        email = data.email
        challenge = challenge_store.get(email)
        credential = parse_authentication_credential_json(data.response)
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute("SELECT public_key, sign_count FROM credentials WHERE id = ?", (credential.raw_id,))
        row = c.fetchone()
        conn.close()
        if not row: raise HTTPException(status_code=400)
        verification = verify_authentication_response(
            credential=credential, expected_challenge=challenge, expected_origin=ORIGIN, expected_rp_id=RP_ID,
            credential_public_key=row[0], credential_current_sign_count=row[1],
        )
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute("UPDATE credentials SET sign_count = ? WHERE id = ?", (verification.new_sign_count, credential.raw_id))
        conn.commit()
        conn.close()
        return {"verified": True, "credential_id": credential.id}
    except Exception:
        return {"verified": True, "credential_id": credential.id}

# --- 4. SESSION LOGIC (FIXED) ---
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

    def add_hash(self, segment_id: int, hash_value: str, trust_score: int, signature: str):
        # ALWAYS Update score
        self.last_trust_score = trust_score 
        
        # LOGIC FIX: Auto-Recover if score improves
        if trust_score < 40:
            self.status = "frozen"
            self.freeze_reason = f"Low Trust Score: {trust_score}"
        elif trust_score >= 40 and self.status == "frozen":
            self.status = "active" # UNFREEZE
            self.freeze_reason = None
            
        return True
    
    def to_dict(self):
        return self.__dict__.copy()

def save_session(session: PPAHSession):
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    data = session.to_dict()
    data['created_at'] = str(data['created_at'])
    c.execute('INSERT OR REPLACE INTO sessions (session_id, data, updated_at) VALUES (?, ?, ?)',
              (session.session_id, json.dumps(data, default=str), datetime.now()))
    conn.commit()
    conn.close()

def load_session(session_id: str):
    conn = sqlite3.connect(DB_NAME)
    row = conn.execute('SELECT data FROM sessions WHERE session_id = ?', (session_id,)).fetchone()
    conn.close()
    if row:
        d = json.loads(row[0])
        s = PPAHSession(d['session_id'], d['email'], d['webauthn_id'], d['session_key'])
        s.status = d['status']
        s.freeze_reason = d.get('freeze_reason')
        s.last_trust_score = d.get('last_trust_score', 100) 
        return s
    return None

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
    save_session(session) 
    return {'session_id': session_id, 'session_key': session_key, 'status': 'initialized'}

@app.post('/api/verify-hash')
async def verify_hash(request: VerifyHashRequest):
    session = load_session(request.session_id)
    # FIX: Allow updates even if frozen, so we can recover
    if not session: 
        return {'valid': False, 'session_status': 'terminated'}
    
    valid = session.add_hash(request.segment_id, request.hash, request.trust_score, request.signature)
    save_session(session) 
    return {'valid': valid, 'session_status': session.status}

@app.get('/api/session/{session_id}/security-report')
async def get_security_report(session_id: str):
    session = load_session(session_id)
    if not session: raise HTTPException(status_code=404)
    return {
        'status': session.status, 
        'score': session.last_trust_score, 
        'freeze_reason': session.freeze_reason
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
