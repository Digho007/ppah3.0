# PPAH 2.0: Privacy-Preserving Adaptive Hashing

> **Multi-Modal Continuous Identity Verification for the Post-Deepfake Era**

[](https://opensource.org/licenses/MIT) [](https://www.google.com/search?q=https://github.com/Digho007/ppah) [](https://en.wikipedia.org/wiki/Zero-knowledge_proof)

## 📖 Overview

**PPAH 2.0** is a web-based, privacy-first security framework designed to verify remote users continuously without resorting to intrusive surveillance.

Unlike traditional video calls (Zoom/Teams) that stream raw pixel data, PPAH uses **Client-Side Edge Computing** to analyze biometric and cryptographic signals locally. It transmits only mathematical hashes and digital signatures to the server, ensuring **Zero-Knowledge Privacy** while proving that the user is present, alive, and authorized.

## 🚀 Key Innovations

### 1\. Multi-Modal Security Architecture

The system employs a "Defense-in-Depth" strategy, layering four distinct security checks:

  * **Hardware Layer:** WebAuthn (FIDO2) attestation locks the session to a specific physical device.
  * **Temporal Layer:** Cryptographic Hash Chaining (`SHA-256`) detects frame injection or deletion attacks.
  * **Biometric Layer:** Real-time histogram and edge-density analysis locks the session to the specific user's facial signature.
  * **Integrity Layer:** **HMAC-SHA256** packet signing prevents Man-in-the-Middle (MitM) replay attacks.

### 2\. Adaptive Trust Scoring

Instead of a binary "Pass/Fail" that frustrates users, PPAH 3.0 uses an **Adaptive Trust Score (0-100)**.

  * **Environmental Healing:** If lighting conditions change, the system lowers the trust score but continues monitoring. If the user remains consistent, the score "heals" back to 100%.
  * **Rolling Anchors:** The biometric baseline evolves over time to adapt to natural environmental drift (e.g., sunset).

### 3\. Ultra-Low Bandwidth

By transmitting hashes instead of video, PPAH operates on **\< 1 Kbps** bandwidth, making high-security verification accessible in rural areas or on 2G/EDGE connections.

## 🛠️ Technical Architecture

### Frontend (Client)

  * **Framework:** Next.js (React)
  * **Processing:** **Web Workers** offload heavy computer vision tasks (histograms, frame differencing) to a background thread, maintaining 60 FPS UI performance.
  * **Algorithms:**
      * *Biometrics:* Bhattacharyya Distance (Color Histograms) & Laplacian Edge Detection.
      * *Liveness:* Frame-to-frame motion energy & Color Temperature analysis.
      * *Optimization:* `Canvas2D` with `willReadFrequently: true` for hardware acceleration.

### Backend (Server)

  * **Framework:** Python (FastAPI)
  * **Verification:**
      * **Sliding Window Logic:** Tolerates network packet loss (gaps of 1-2 frames) without breaking the security chain.
      * **HMAC Verification:** Validates the cryptographic signature of every incoming heartbeat using a session-specific secret key.

## ⚡ Quick Start

### Prerequisites

  * Node.js (v18+)
  * Python (v3.9+)

### 1\. Setup Backend

```bash
cd server
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install fastapi uvicorn
uvicorn ppah_server:app --reload --host 0.0.0.0 --port 8000
```

### 2\. Setup Frontend

```bash
cd ../client
npm install
npm run dev
```

### 3\. Run the System

Open `http://localhost:3000` (or your VM IP) in a browser.

## 🧪 Testing & Data Collection

To validate the system for research purposes, use the built-in simulation tools:

| Test Case | Action | Expected Outcome |
| :--- | :--- | :--- |
| **Normal Operation** | Run for 60s | Trust Score stays \> 90%. Logs show `[VERIFY] ... Segment X ✓`. |
| **Injection Attack** | Click **"Simulate Attack"** button | Trust Score hits 0%. Server logs `[SECURITY] Segment sequence break`. |
| **User Swap** | Have a different person enter frame | Console shows `[BIOMETRIC] Similarity: < 60%`. Trust Score drains. |
| **Spoofing** | Hold up a static photo | Liveness score drops. System triggers "Turn Head" challenge. |

## 🛡️ Privacy & Compliance

This project helps organizations meet **GDPR, CCPA, and NDPR** data minimization requirements:

1.  **No Face Storage:** Facial images are processed in volatile memory (RAM) and destroyed immediately.
2.  **No Surveillance:** The server administrator cannot "watch" the user; they only see a cryptographic proof of presence.

## 🔮 Future Work

  * **Deep Learning Integration:** Replacing heuristic histograms with client-side TensorFlow.js (MediaPipe) for higher accuracy on high-end devices.
  * **Zero-Knowledge Proofs (ZKP):** Implementing zk-SNARKs to prove liveness without revealing any biometric metadata.

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

-----

*Research & Implementation by Jeremiah Dighomanor.*
