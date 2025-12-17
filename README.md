Here is a professional, comprehensive **README.md** for your project. I have structured it to highlight the upgrade from v2.0 to v3.0, specifically focusing on the new **Remote Session** capabilities.

You can copy and paste this directly into your project root.

---

# PPAH 3.0: Privacy-Preserving Adaptive Hashing with Remote Sessions

**PPAH 3.0** is a secure, privacy-first video verification platform designed to prevent deepfakes and unauthorized access in remote communications. Unlike PPAH 2.0, which focused on local verification, **PPAH 3.0 introduces real-time Remote Sessions**, allowing two parties to establish a cryptographically secured video call where user integrity is continuously monitored.

> **USP:** PPAH implements a **Zero-Trust Architecture**. It anchors digital identity to physical hardware (WebAuthn) and continuously signs video frames based on biometric trust scores, effectively rendering virtual camera injections and deepfakes useless.

## 🚀 What's New in v3.0?

* **Remote Session Support:** Users can now join secure "Rooms" via WebRTC to conduct verified video calls.
* **Draggable PIP Interface:** A Zoom-style UI with a draggable local video (Picture-in-Picture) and full-screen remote view.
* **Adaptive Trust Scoring:** Real-time monitoring that adjusts security checks based on user behavior (e.g., looking away, leaving the camera).
* **Deepfake Resistance:** Cryptographic signing of every video frame ensures that the video feed cannot be hijacked by OBS or virtual cameras.

## 🌟 Key Features

### 1. Hardware-Anchored Identity (WebAuthn)

* **No Passwords:** Login requires a physical FIDO2 key, Fingerprint, or FaceID.
* **Anti-Phishing:** Credentials are bound to the specific domain, making phishing attacks impossible.

### 2. Adaptive Hashing & Integrity

* **Dynamic Signatures:** Every video frame is hashed and signed locally. The signature is valid *only* if the user's current Trust Score is high.
* **Liveness Challenges:** If the Trust Score drops (e.g., < 60%), the system pauses the stream and forces a challenge (e.g., "Turn Head Left").

### 3. Privacy-Preserving Monitoring

* **Local Processing:** Biometric analysis (Face Detection, Head Pose) runs entirely in the browser (Client-Side).
* **Minimal Data Leakage:** The server receives hashes and signatures, not raw biometric data.

---

## 🛠️ Tech Stack

* **Frontend:** Next.js (React), Tailwind CSS, MediaPipe (Biometrics), SimpleWebAuthn (FIDO2).
* **Backend:** FastAPI (Python), SQLite (Database), WebSockets (Signaling).
* **Security:** WebAuthn (FIDO2), HMAC-SHA256 (Frame Signing), WebRTC (P2P Encryption).

---

## ⚡ Installation & Setup

### Prerequisites

* Python 3.9+
* Node.js 16+
* Ngrok (Required for WebAuthn on mobile/remote testing)

### 1. Backend Setup (FastAPI)

Navigate to the root directory:

```bash
# Create virtual environment
python -m venv venv

# Activate (Windows)
venv\Scripts\activate
# Activate (Mac/Linux)
source venv/bin/activate

# Install dependencies
pip install fastapi uvicorn webauthn[fastapi]

# Start Server
# NOTE: Update NGROK_DOMAIN in server/ppah_server.py first!
python -m uvicorn server.ppah_server:app --reload --host 0.0.0.0 --port 8000

```

### 2. Frontend Setup (Next.js)

Open a new terminal:

```bash
cd client

# Install dependencies
npm install

# Start Frontend
npm run dev

```

### 3. Expose to Internet (Ngrok)

WebAuthn requires a secure context (HTTPS) or localhost. To test on mobile:

```bash
ngrok http 3000

```

*Copy the forwarding URL (e.g., `https://abcd-123.ngrok-free.app`) and update `NGROK_DOMAIN` in `server/ppah_server.py`.*

---

## 📱 Usage Guide

1. **Open the App:** Go to your Ngrok URL on your phone or desktop.
2. **Register Key:** Click **"Register Key"**. Use your Fingerprint/FaceID when prompted.
3. **Join a Room:** Enter a unique Room Name (e.g., `Exam-Room-1`) and click **"Start Secure Video Call"**.
4. **Verification:** The system will verify your biometric key and initialize the camera.
5. **The Session:**
* **High Trust (100%):** Call proceeds normally.
* **Low Trust (<60%):** You will be asked to perform a head movement challenge.
* **Zero Trust (0%):** Session is flagged or terminated.



---

## ⚠️ Troubleshooting

**"User Not Found" Error:**

* You must click **"Register Key"** *before* trying to start a call. The system needs to save your public key first.

**"Hardware Authentication" Fails Immediately:**

* Check your `server/ppah_server.py`. Ensure `NGROK_DOMAIN` matches your browser URL **exactly** (no `https://` prefix in the variable).
* Ensure you are accessing via HTTPS (Ngrok), not HTTP.

**Database Errors (sqlite3):**

* If you changed the schema recently, delete the old database file:
```bash
rm server/ppah_enterprise.db

```


The server will recreate it automatically on restart.

---

## 📄 License

This project is proprietary software developed for high-security verification research. Unauthorized copying or distribution is prohibited.
