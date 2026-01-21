from pydantic import BaseModel
from typing import Dict, Any, Optional
from datetime import datetime
import json
import sqlite3
from .database import DatabaseManager

# --- Pydantic Schemas ---
class WebAuthnResponse(BaseModel):
    email: str
    response: Dict[str, Any]

class InitSessionRequest(BaseModel):
    email: str
    webauthn_credential_id: str

class VerifyHashRequest(BaseModel):
    session_id: str
    segment_id: int
    hash: str
    trust_score: int 
    signature: str 

# --- Business Logic ---
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
        data = self.__dict__.copy()
        data['created_at'] = str(data['created_at'])
        return data

    @staticmethod
    def load(session_id: str):
        # Direct DB access via sqlite3 to avoid circular dependency complexity, 
        # or reuse DatabaseManager if methods are generic enough.
        # Here we use the generic DB_NAME import from database.py if needed, 
        # or just raw SQL for the specific 'sessions' table lookups.
        from .database import DB_NAME 
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
        from .database import DB_NAME
        with sqlite3.connect(DB_NAME) as conn:
            c = conn.cursor()
            data = self.to_dict()
            c.execute('INSERT OR REPLACE INTO sessions (session_id, data, updated_at) VALUES (?, ?, ?)',
                      (self.session_id, json.dumps(data, default=str), datetime.now()))
            conn.commit()
