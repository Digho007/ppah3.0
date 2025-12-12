// client/public/biometric-worker.js

self.onmessage = async (e) => {
  const { type, imageData, previousFrames, anchorBiometric } = e.data;

  if (type === 'ANALYZE_FRAME') {
    // 1. Normalize Lighting
    const normalizedData = applyLightingNormalization(imageData);

    // 2. Compute Fingerprint
    const fingerprint = createBiometricFingerprint(normalizedData);
    
    // 3. Compute Liveness
    let liveness = 0;
    if (previousFrames && previousFrames.length >= 2) {
      liveness = computeLivenessScore(imageData, previousFrames);
    }

    // 4. Compare with Anchor
    let similarity = 0;
    if (anchorBiometric) {
      similarity = compareBiometrics(fingerprint, anchorBiometric);

      // --- NEW: ROLLING ANCHOR UPDATE ---
      // If the match is very strong (>90%), we assume the user is valid 
      // and slightly blend the current frame into the anchor.
      // This allows the system to adapt to "Sunset" or "Lights Dimming" automatically.
      if (similarity > 0.90) {
         const newAnchor = blendBiometrics(anchorBiometric, fingerprint, 0.05); // 5% adaptation rate
         
         // Send the updated anchor back to the main thread
         self.postMessage({
            type: 'ANCHOR_UPDATED',
            fingerprint: newAnchor
         });
      }
    }

    self.postMessage({
      type: 'ANALYSIS_RESULT',
      fingerprint,
      liveness,
      similarity
    });
  } 
  else if (type === 'GENERATE_ANCHOR') {
    const normalizedData = applyLightingNormalization(imageData);
    const fingerprint = createBiometricFingerprint(normalizedData);
    self.postMessage({ type: 'ANCHOR_GENERATED', fingerprint });
  }
};

// --- HELPERS ---

function blendBiometrics(oldBio, newBio, rate) {
    // Weighted Average: New = (Old * 0.95) + (New * 0.05)
    const newHist = oldBio.histogram.map((val, i) => 
        (val * (1 - rate)) + (newBio.histogram[i] * rate)
    );
    
    const newEdge = (oldBio.edgeDensity * (1 - rate)) + (newBio.edgeDensity * rate);
    
    return {
        histogram: newHist,
        edgeDensity: newEdge
    };
}

function applyLightingNormalization(imageData) {
  const { width, height, data } = imageData;
  const newData = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const sum = r + g + b + 1; 
    newData[i] = (r / sum) * 255;     
    newData[i+1] = (g / sum) * 255;   
    newData[i+2] = (r + g + b) / 3;   
    newData[i+3] = 255;               
  }
  return { width, height, data: newData };
}

function createBiometricFingerprint(imageData) {
  const centerRegion = extractCenterRegion(imageData);
  return {
    histogram: computeColorHistogram(centerRegion),
    edgeDensity: extractEdgeDensity(centerRegion)
  };
}

function extractCenterRegion(imageData) {
  const { width, height, data } = imageData;
  const cw = Math.floor(width * 0.4), ch = Math.floor(height * 0.4);
  const sx = Math.floor((width - cw) / 2), sy = Math.floor((height - ch) / 2);
  const newData = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const srcIdx = ((sy + y) * width + (sx + x)) * 4;
      const dstIdx = (y * cw + x) * 4;
      newData[dstIdx] = data[srcIdx]; newData[dstIdx+1] = data[srcIdx+1];
      newData[dstIdx+2] = data[srcIdx+2]; newData[dstIdx+3] = data[srcIdx+3];
    }
  }
  return { width: cw, height: ch, data: newData };
}

function computeColorHistogram(imageData) {
  const histogram = new Array(512).fill(0);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = Math.floor(data[i]/32), g = Math.floor(data[i+1]/32), b = Math.floor(data[i+2]/32);
    histogram[r*64 + g*8 + b]++;
  }
  const total = imageData.width * imageData.height;
  return histogram.map(count => count / total);
}

function extractEdgeDensity(imageData) {
  const data = imageData.data;
  let edgeCount = 0;
  const width = imageData.width;
  for (let i = 0; i < data.length - width * 4 - 4; i += 4) {
    const current = data[i];
    const right = data[i + 4];
    const below = data[i + width * 4];
    if (Math.abs(current - right) > 100 || Math.abs(current - below) > 100) edgeCount++;
  }
  return edgeCount / (imageData.width * imageData.height);
}

function compareBiometrics(b1, b2) {
  let sum = 0;
  for (let i = 0; i < b1.histogram.length; i++) sum += Math.sqrt(b1.histogram[i] * b2.histogram[i]);
  const histSim = sum;
  const edgeSim = 1 - Math.abs(b1.edgeDensity - b2.edgeDensity);
  return histSim * 0.7 + edgeSim * 0.3;
}

function computeLivenessScore(current, prevFrames) {
  let motion = 0;
  const currData = current.data;
  const prevData = prevFrames[prevFrames.length - 1].data;
  let diff = 0, samples = 0;
  for (let i = 0; i < currData.length; i += 40) { 
    diff += Math.abs(currData[i] - prevData[i]);
    samples++;
  }
  motion = diff / samples;
  return Math.min(motion / 10, 1.0) * 100;
}
