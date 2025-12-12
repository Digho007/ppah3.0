# PPAH 2.0: Remote Session Security

> **Privacy-Preserving Adaptive Hashing for Deepfake-Proof Remote Verification**

[](https://opensource.org/licenses/MIT) [](https://www.google.com/search?q=https://github.com/Digho007/ppah)

## 📖 Overview

PPAH 2.0 is a **web-only, passwordless, and privacy-first** remote verification system designed to secure remote sessions against post-verification deepfake injection attacks.

Unlike traditional KYC tools that only verify a user once at the start, PPAH provides **continuous integrity monitoring**. It establishes a cryptographic baseline of the user's video feed and silently validates the stream in real-time. If a deepfake injection or virtual camera switch is attempted after authentication, the hash chain breaks, and the session is immediately frozen.

## 🚀 How It Works

The system follows a zero-trust, zero-install flow:

1.  **Device Attestation (WebAuthn):** The user clicks a secure link. Before accessing the camera, the system challenges the device using WebAuthn (Passkeys/TouchID/FaceID). This ensures the session is initiated by a human on a secure device, eliminating phishing and bot risks.
2.  **Secure Baseline Creation:** Once authenticated, the system activates the camera for 3–5 seconds to confirm a physical video feed (blocking OBS/Virtual Cams) and generates the initial PPAH baseline hash.
3.  **Continuous Adaptive Hashing:** The browser calculates cryptographic hashes of video segments locally. These hashes are sent to the backend to verify the **Chain of Custody**.
4.  **Real-Time Threat Detection:** If a bad actor attempts to inject a deepfake or swap the video source, the hash immediately diverges from the expected sequence. The backend detects the anomaly and terminates the session instantly.

## ✨ Key Features

  * **🚫 Passwordless & Phishing-Resistant:** Relies entirely on WebAuthn (FIDO2), removing the need for passwords, SMS OTPs, or vulnerable phone numbers.
  * **🛡️ Deepfake Injection Proof:** Continuous monitoring ensures that the user verified at the start is the same user present 10 minutes later.
  * **🔒 Privacy-First Architecture:** **Zero raw video data leaves the device.** All video processing and hashing occur client-side; only the cryptographic hashes are transmitted to the server.
  * **🌐 Zero-Install Deployment:** Runs natively in any modern browser (Chrome, Safari, Edge) on mobile and desktop without requiring app downloads.

## 🛠️ Tech Stack

  * **Frontend:** React (Next.js/Vite), WebAuthn API, HTML5 Canvas (for frame processing).
  * **Backend:** Python (FastAPI) for hash verification and session management.
  * **Security:** SHA-256 for frame hashing, ECDSA/RSA for WebAuthn signatures.

## ⚡ Quick Start

### Prerequisites

  * Node.js (v18+)
  * Python (v3.9+)

### Installation

1.  **Clone the repository**

    ```bash
    git clone https://github.com/Digho007/ppah2.0.git
    cd ppah2.0
    ```

2.  **Setup Backend**

    ```bash
    cd server
    python -m venv venv
    source venv/bin/activate  # or venv\Scripts\activate on Windows
    pip install fastapi uvicorn
    uvicorn ppah_server:app --reload --host 0.0.0.0 --port 8000
    ```

3.  **Setup Frontend**

    ```bash
    cd ../client
    npm install
    npm run dev
    ```

4.  **Access the App**

      * Open `http://localhost:3000` (or your VM IP) in a browser.

## 🛡️ Privacy Notice

This project adheres to strict privacy-by-design principles. Biometric data (video frames) is processed in volatile memory within the user's browser and is never stored or transmitted.

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

-----

*Research & Implementation by Jeremiah Dighomanor.*
