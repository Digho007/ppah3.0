from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Body
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Any
import hashlib
import hmac
import secrets
import json
import logging

# --- NEW IMPORTS ---
from .database import DatabaseManager
from .models import (
    WebAuthnResponse, InitSessionRequest, VerifyHashRequest, PPAHSession
)
from .signaling import manager

# --- WEBAUTHN LIBS ---
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

# --- SETUP ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("PPAH_Server")

app = FastAPI(title="PPAH Enhanced Verification API - SCALABLE")

# Config
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

# Init DB
DatabaseManager.init_db()
challenge_store = {} 

# --- WEBAUTHN ROUTES ---

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
        if not challenge: raise HTTPException(400, "Challenge expired")

        credential = parse_registration_credential_json(data.response)
        verification = verify_registration_response(
            credential=credential, expected_challenge=challenge, expected_origin=ORIGIN, expected_rp_id=RP_ID,
        )
        DatabaseManager.save_credential(
            verification.credential_id, email, 
            verification.credential_public_key, verification.sign_count
        )
        del challenge_store[email]
        return {"verified": True}
    except Exception as e:
        logger.error(f"Reg Error: {e}")
        raise HTTPException(400, f"Registration failed: {str(e)}")

@app.post("/api/webauthn/login/options")
async def login_options(data: dict = Body(...)):
    email = data.get("email")
    rows = DatabaseManager.get_credential(email)
    if not rows: raise HTTPException(404, "User not registered")
    
    allow_credentials_list = [PublicKeyCredentialDescriptor(id=row[0], type=PublicKeyCredentialType.PUBLIC_KEY) for row in rows]
    options = generate_authentication_options(
        rp_id=RP_ID, allow_credentials=allow_credentials_list, user_verification=UserVerificationRequirement.PREFERRED
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
        if not row: raise HTTPException(400, "Credential not found")
        
        verification = verify_authentication_response(
            credential=credential, expected_challenge=challenge, expected_origin=ORIGIN, expected_rp_id=RP_ID,
            credential_public_key=row[0], credential_current_sign_count=row[1],
        )
        DatabaseManager.update_sign_count(verification.new_sign_count, credential.raw_id)
        del challenge_store[email]
        return {"verified": True, "credential_id": credential.id}
    except Exception as e:
        logger.error(f"Login Error: {e}")
        raise HTTPException(400, "Authentication failed")

# --- SESSION & SIGNALING ROUTES ---

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
    
    # HMAC Validation (Security Fix)
    message = f"{request.session_id}{request.segment_id}{request.hash}{request.trust_score}".encode('utf-8')
    key = session.session_key.encode('utf-8')
    expected_signature = hmac.new(key, message, hashlib.sha256).hexdigest()
    
    if not hmac.compare_digest(expected_signature, request.signature):
        logger.warning(f"Invalid Signature for Session {request.session_id}")
        return {'valid': False, 'session_status': 'compromised', 'error': 'Invalid Signature'}

    # Logic
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
