# PPAH 3.0: Privacy-Preserving Adaptive Hashing with Remote Sessions

**PPAH 3.0** is a zero-trust, privacy-first video verification platform designed to secure remote sessions against deepfakes, virtual camera injection, and unauthorized access.

Unlike traditional conferencing tools that verify identity only once at login, **PPAH 3.0 enforces Continuous Authentication**. It combines hardware-anchored identity (WebAuthn), Edge AI (MediaPipe), and a novel **Adaptive Hashing Protocol** to cryptographically bind video frame integrity to real-time user behavior.

> **Core Innovation:** The system implements **Adaptive Privacy Blurring**. If the biometric trust score drops due to deepfake artifacts or liveness failure, the remote video feed automatically blurs to protect the viewer, and the hashing interval accelerates (5x) to rigorously re-verify the identity.

---

## 🚀 Key Features & Security Mechanics

### 1. 🛡️ Zero-Trust Enforcement

* **Virtual Camera Blockade:** The system actively scans media driver labels. If software like **OBS, ManyCam, or Virtual Cables** is detected, camera access is immediately revoked.
* **Auto-Termination:** If the Trust Score hits **0%** (Local or Remote), the session is instantly killed.

### 2. 👁️ Adaptive Privacy Blur

* **Trust-Based Visibility:**
* **Score > 60%:** Video is Clear (Trusted).
* **Score < 60%:** Video is **Blurred** (Untrusted). This neutralizes the visual impact of deepfakes.


* **Self-Healing:** Once the user passes a randomized Liveness Challenge (e.g., "Turn Head Left"), the score recovers, and the video unblurs.

### 3. ⚡ Environmental Heuristics

The hashing engine is not static. It monitors the environment in real-time:

* **Baseline:** Hashes 1 frame every **1000ms**.
* **Adaptive Trigger:** If **Scene Brightness** shifts by >10% or **Network Stability** drops, the system assumes a potential attack (e.g., camera swap).
* **Reaction:** The hashing interval drops to **200ms**, forcing the client to prove identity 5x faster.

### 4. 🔐 Hardware-Anchored Identity

* **WebAuthn/FIDO2:** Login is strictly bound to physical hardware (Fingerprint, FaceID, YubiKey). Passwords are eliminated to prevent credential sharing.

---

## 🛠️ Tech Stack

* **Frontend:** Next.js 14 (React), Tailwind CSS, MediaPipe (Edge AI).
* **Backend:** FastAPI (Python), SQLite, WebSockets (Real-time Signaling).
* **Security:** HMAC-SHA256 (Packet Signing), WebAuthn (Auth), WebRTC (P2P Encryption).

---

## ⚡ Installation & Setup

### Prerequisites

* Python 3.10+
* Node.js 18+
* **Ngrok** (Essential for WebAuthn on mobile/remote devices)

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
# ⚠️ IMPORTANT: Update NGROK_DOMAIN in server/ppah_server.py first!
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

WebAuthn requires a secure context (HTTPS) to access biometrics on mobile devices.

```bash
ngrok http 3000

```

* **Step A:** Copy the forwarding URL (e.g., `https://your-app.ngrok-free.app`).
* **Step B:** Update the `NGROK_DOMAIN` variable in `server/ppah_server.py`.
* **Step C:** Restart the Python backend.

---

## 📱 User Guide

1. **Access:** Open the Ngrok HTTPS URL on two devices (e.g., Laptop and Phone).
2. **Register:** Click **"Register Security Key"** on both devices. Authenticate using TouchID/FaceID.
3. **Connect:**
* **User A:** Enters Room ID (e.g., `Room101`) -> Clicks "Start Video Call".
* **User B:** Enters Room ID (`Room101`) -> Clicks "Start Video Call".


4. **The Secure Session:**
* The timer will only start when the connection is established.
* **Try to attack:** Cover your face or look away.
* **Observe:** Your Trust Score drops. On the *other* device, your video will **blur** automatically.
* **Recover:** Perform the head movement challenge to restore the clear video feed.



---

## ⚠️ Troubleshooting

**"Session Terminated: Remote Peer Untrusted"**

* This is not a bug; it is a feature. The remote peer's score hit 0% because they failed the liveness check or blocked their camera for too long. Refresh to reconnect.

**Timer isn't starting**

* The timer is strictly synchronized. It waits for the **Peer Connection (WebRTC)** to complete. Ensure both devices are on the same Room ID and `iceStatus` says "Connected".

**Video is constantly blurry**

* Check the server logs. If the server considers the session "Frozen" (Score < 40%), it will enforce the blur. Perform the liveness challenge (Head Yaw) to unfreeze.

*Works strictly on Google Chrome because it supports WebAuthn*
---

## 📄 License

**Proprietary Research Software.** Developed for the "Privacy-Preserving Adaptive Hashing" academic study. Unauthorized distribution is prohibited.


## 👥 Authors & Contributors

* **Jeremiah Dighomanor** - *Lead Researcher & Developer* - [jeremiahdighomanor@gmail.com]
* **David Ogar** - *Research Associate / Co-Developer*
* **Alex Omosigho** - *Research Associate / Co-Developer*
* **Ndifreke Sam** - *Research Mentor*

*Affiliation: Wale Lab Fellow*
