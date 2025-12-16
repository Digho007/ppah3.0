// client/public/biometric-worker.js

self.onmessage = async (e) => {
  const { type, imageData, previousFrames, anchorBiometric, goldenAnchor } = e.data;

  if (type === 'ANALYZE_FRAME') {
    // 1. Normalize
    const normalizedData = applyLightingNormalization(imageData);
    const fingerprint = createBiometricFingerprint(normalizedData);
    
    // 2. Liveness (Motion)
    let liveness = 0;
    if (previousFrames && previousFrames.length >= 2) {
      liveness = computeLivenessScore(imageData, previousFrames);
    }

    // 3. Compare with Anchors (Dual Check)
    let similarity = 0;
    
    if (anchorBiometric && goldenAnchor) {
        // A. Rolling Anchor Check (Adapts to lighting)
        const rollingScore = compareBiometrics(fingerprint, anchorBiometric);
        
        // B. Golden Anchor Check (Strict Identity)
        const goldenScore = compareBiometrics(fingerprint, goldenAnchor);
        
        // C. Weighted Score (Favor Golden Anchor to prevent drift)
        similarity = (rollingScore * 0.4) + (goldenScore * 0.6);
        
        // Update Rolling Anchor ONLY if match is very high
        if (similarity > 0.90) {
            const newRolling = blendBiometrics(anchorBiometric, fingerprint, 0.05);
            self.postMessage({
                type: 'ANCHOR_UPDATED',
                fingerprint: newRolling
            });
        }
    } 
    else if (anchorBiometric) {
        // Fallback (Initialization phase)
        similarity = compareBiometrics(fingerprint, anchorBiometric);
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
    // Return this as BOTH the initial rolling anchor AND the golden anchor
    self.postMessage({ type: 'ANCHOR_GENERATED', fingerprint });
  }
};

// --- HELPERS (Unchanged from original logic, just condensed for copy-paste) ---

function blendBiometrics(oldBio, newBio, rate) {
    const newHist = oldBio.histogram.map((val, i) => (val * (1 - rate)) + (newBio.histogram[i] * rate));
    const newEdge = (oldBio.edgeDensity * (1 - rate)) + (newBio.edgeDensity * rate);
    return { histogram: newHist, edgeDensity: newEdge };
}

function applyLightingNormalization(imageData) {
  const { width, height, data } = imageData;
  const newData = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const sum = r + g + b + 1; 
    newData[i] = (r / sum) * 255; newData[i+1] = (g / sum) * 255;   
    newData[i+2] = (r + g + b) / 3; newData[i+3] = 255;               
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
  return histogram.map(count => count / (imageData.width * imageData.height));
}

function extractEdgeDensity(imageData) {
  const data = imageData.data;
  let edgeCount = 0;
  const width = imageData.width;
  for (let i = 0; i < data.length - width * 4 - 4; i += 4) {
    if (Math.abs(data[i] - data[i+4]) > 100 || Math.abs(data[i] - data[i+width*4]) > 100) edgeCount++;
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
  const currData = current.data;
  const prevData = prevFrames[prevFrames.length - 1].data;
  let diff = 0, samples = 0;
  for (let i = 0; i < currData.length; i += 40) { 
    diff += Math.abs(currData[i] - prevData[i]);
    samples++;
  }
  return Math.min((diff / samples) / 10, 1.0) * 100;
}
