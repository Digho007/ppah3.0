# Testing Guide for Trust Score & Security Updates

This guide explains how to test the improvements made to Trust Score dynamics, scene shift detection, and adaptive hashing.

## Quick Start

### 1. Setup the Application

```bash
# Terminal 1: Start Backend
cd /home/runner/work/ppah3.0/ppah3.0
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r server/requirements.txt
python -m server.ppah_server

# Terminal 2: Start Frontend
cd /home/runner/work/ppah3.0/ppah3.0/client
npm install
npm run dev
```

### 2. Open Browser Console

**Important:** Open Chrome DevTools (F12) to see the enhanced logging from the updates.

- Navigate to `http://localhost:3000`
- Open Console tab to monitor logs tagged with `[PPAH]`

## What to Test

### Test 1: EMA Smoothing (Trust Score Gradual Changes)

**Objective:** Verify trust score changes smoothly instead of jumping abruptly.

**Steps:**
1. Start a video call and allow face detection to work normally
2. Cover your face briefly (triggers "No Face" penalty)
3. **Observe:** Trust score should decrease gradually, not jump instantly
4. Uncover your face
5. **Observe:** Trust score should recover smoothly over several frames

**Expected Logs:**
```
[PPAH Security] Event: No Face, Penalty: 2, Current Score: 98
[PPAH Security] Event: No Face, Penalty: 2, Current Score: 96
```

**Before Update:** Score would jump from 100 → 90 instantly  
**After Update:** Score transitions smoothly: 100 → 97 → 94 → 91 (EMA smoothing)

### Test 2: Combined Heuristics (Scene Shift Detection)

**Objective:** Verify that natural brightness changes (e.g., turning on a light) don't trigger false scene shift alerts.

**Steps:**
1. Start video call with normal lighting
2. Slowly increase room brightness (e.g., turn on desk lamp)
3. **Observe Console:** Should see "Natural brightness change detected (gradual)" - NO penalty
4. Rapidly change video source (if testing with OBS/virtual camera)
5. **Observe Console:** Should see "Scene Shift Detected" with BOTH brightness and entropy deltas

**Expected Logs for Natural Change:**
```
[PPAH] Natural brightness change detected (gradual): 25.3
```

**Expected Logs for Actual Scene Shift:**
```
[PPAH] Scene Shift Detected - Brightness: 28.4, Entropy: 1.15, Variance: 12.8
[PPAH Security] Event: Scene Shift, Penalty: 8, Current Score: 95
```

**Key Difference:**
- **Natural change:** Only brightness changes, entropy stays similar, no penalty
- **Scene shift:** BOTH brightness AND entropy change significantly, penalty applied

### Test 3: Weighted Adaptive Hashing Intervals

**Objective:** Verify hashing interval adjusts dynamically based on trust score, network, and environment.

**Steps:**
1. Start call with good conditions (face visible, stable network)
2. **Observe Console:** Should see interval at 1000ms (normal)
3. Cover face to lower trust score below 80
4. **Observe Console:** Interval should adjust to 500ms or 300ms
5. Trigger scene shift (if possible)
6. **Observe Console:** Interval should drop to 250ms (most aggressive)

**Expected Logs (only logged on change):**
```
[PPAH Adaptive Hash] Moderate monitoring, combined score: 0.65, interval: 500ms
[PPAH Adaptive Hash] Heightened monitoring, combined score: 0.42, interval: 300ms
[PPAH Adaptive Hash] Aggressive mode active, interval: 250ms
```

**Before Update:** Binary 200ms or 1000ms  
**After Update:** Gradual 250ms → 300ms → 500ms → 1000ms based on weighted score

### Test 4: Enhanced Error Logging

**Objective:** Verify errors are logged with full context.

**Steps:**
1. Disconnect network briefly while in call
2. **Observe Console:** Network errors should be logged with segment info
3. Check that session continues after network recovers (fallback mechanism)

**Expected Logs:**
```
[PPAH Network] Hash verification failed for segment 42: TypeError: Failed to fetch
[PPAH Monitoring Error] Frame processing failed: { error: ..., segment: 42, trustScore: 87, ... }
```

### Test 5: Environmental Stability Tracking

**Objective:** Verify system adapts thresholds based on environment.

**Steps:**
1. Start call in stable lighting (no changes for 10+ seconds)
2. **Observe:** System should use stricter thresholds (20 for brightness, 0.8 for entropy)
3. Make small lighting adjustments repeatedly
4. **Observe:** System should use relaxed thresholds (30 for brightness, 1.2 for entropy)

**Check Console for:**
```
// Stable environment (variance < 50)
Brightness threshold: 20, Entropy threshold: 0.8

// Unstable environment (variance >= 50)
Brightness threshold: 30, Entropy threshold: 1.2
```

## Visual Indicators in UI

### Trust Score Display
- **Green (>80%):** Normal operation
- **Red (<80%):** Monitoring intensified
- Watch for smooth transitions instead of jumps

### Remote Video Blur
- **Score > 60%:** Clear video
- **Score < 60%:** Blurred video
- Should transition smoothly with EMA

## Performance Verification

### Check for Reduced Log Noise
**Before Update:** Logs would spam every frame  
**After Update:** Logs only appear when:
- Interval changes
- Significant events occur
- Errors happen

### Verify Optimizations
The variance calculation should be faster (single-pass algorithm). No visible impact, but better CPU usage.

## Common Scenarios to Test

| Scenario | Expected Behavior |
|----------|------------------|
| Sunlight through window | Natural change logged, NO penalty |
| Turn on/off room light gradually | Natural change, NO penalty |
| Switch camera/video source rapidly | Scene shift detected, penalty applied |
| Cover face briefly | Gradual score decrease via EMA |
| Network hiccup | Error logged, session continues |
| Stable environment | Stricter thresholds (20/0.8) |
| Changing environment | Relaxed thresholds (30/1.2) |

## Debugging Tips

1. **Filter Console Logs:** Type `[PPAH` in Chrome console filter to see only relevant logs
2. **Watch Trust Score:** It should NEVER jump more than ~3-5 points per frame with EMA
3. **Monitor Intervals:** Should only log when transitioning between tiers
4. **Check Timestamps:** Natural changes should be >10 seconds apart

## Build Verification

```bash
# Ensure no TypeScript errors
cd client
npm run build

# Should show: ✓ Compiled successfully
```

## What Changed (Summary)

- ✅ **EMA Smoothing:** Trust score changes gradually (α=0.3)
- ✅ **Combined Heuristics:** Requires brightness + entropy changes
- ✅ **Weighted Intervals:** 4-tier system (250/300/500/1000ms)
- ✅ **Enhanced Logging:** Tagged, contextual, throttled
- ✅ **Stability Tracking:** Dynamic thresholds based on environment
- ✅ **Performance:** Optimized variance calculation, bounds checking

## Need Help?

If you encounter issues:
1. Check console for `[PPAH Error]` tagged messages
2. Verify trust score changes smoothly (not jumping)
3. Confirm interval logs only appear on transitions
4. Check that natural lighting changes don't trigger scene shift alerts
