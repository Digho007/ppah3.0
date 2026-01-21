import sqlite3
import logging

DB_NAME = "ppah_enterprise.db"
logger = logging.getLogger("PPAH_DB")

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
            return c.fetchall()

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
