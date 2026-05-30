# Review: Pi Model Router Logical Correctness and Implementation Fidelity

## Overview
This review examines the pi-model-router codebase with a focus on logical correctness and implementation fidelity to the original request. The analysis covers the context threshold replacement (largeContextThreshold -> defaultContextThresholdPercent) and the new tier-based model selection algorithm.

## Correct Implementation Areas

### 1. Context Threshold Calculation and Override Logic ✅
**Location**: `extensions/provider.ts` lines 195-226, `extensions/config.ts` lines 144-149, `extensions/types.ts` lines 51-54

The implementation correctly handles the context threshold replacement:

- **Configuration Structure**: The `defaultContextThresholdPercent` and `contextThresholdPercentOverrides` are properly defined in the config schema
- **Threshold Calculation**: The threshold is calculated as `Math.floor((thresholdPercent / 100) * m.contextWindow)` which correctly converts percentage to token count
- **Override Logic**: The implementation correctly checks for model-specific overrides before falling back to the default percentage
- **Integration**: The threshold check is properly integrated into the tier search loop, ensuring context requirements are considered alongside image support

### 2. Tier-Based Model Search Logic ✅
**Location**: `extensions/provider.ts` lines 175-196

The new tier-based model selection correctly searches current tier before escalating:

```typescript
const tiersToSearch = ROUTER_TIERS.slice(0, ROUTER_TIERS.indexOf(decision.tier) + 1).reverse();
```

This logic:
- Uses `ROUTER_TIERS = ['high', 'medium', 'low']` to ensure proper ordering
- Searches from the decision tier upwards (high to low when decision is high, medium to low when decision is medium, etc.)
- Properly handles the case where the decision tier doesn't have suitable models

### 3. Image-Aware Routing Integration ✅
**Location**: `extensions/provider.ts` lines 154-158, 196-199

The image detection and escalation logic is correctly integrated:

- **Detection**: `imageDetectedInRecentContext()` properly checks for image attachments in recent messages
- **Model Support Check**: `checkModelSupportsImage()` validates model capabilities
- **Tier Escalation**: The search properly escalates to higher tiers when current tier models don't support images
- **Context Preservation**: Image requirements are checked alongside context thresholds during model selection

### 4. Routing Decision Pipeline ✅
**Location**: `extensions/provider.ts` lines 90-174, `extensions/routing.ts` lines 108-158

The decision pipeline follows the correct order:
1. Google lock preservation
2. Manual pin check
3. Custom rules matching
4. Heuristic analysis
5. Classifier gating (when enabled)
6. Post-route corrections (image escalation, context thresholds)

## Issues Found

### 1. Context Threshold Trigger Logic - Logical Error ❌
**Location**: `extensions/provider.ts` lines 175-196

**Issue**: The context threshold implementation has a logical flaw in the tier search loop. When a context threshold is exceeded, the code should escalate to higher tiers, but the current implementation doesn't properly handle the case where the decision tier itself might be forced to escalate.

```typescript
// Current problematic logic in tier search loop
const tiersToSearch = ROUTER_TIERS.slice(0, ROUTER_TIERS.indexOf(decision.tier) + 1).reverse();

tierSearch: for (const t of tiersToSearch) {
  const modelsInTier = [profile[t].model, ...(profile[t].fallbacks ?? [])];
  for (const modelRef of modelsInTier) {
    // 1. Check image support
    if (detectedImageInRecentContext && !checkModelSupportsImage(modelRef, state.currentModelRegistry)) {
      continue;
    }

    // 2. Check context threshold
    const { provider, modelId } = parseCanonicalModelRef(modelRef);
    const m = state.currentModelRegistry?.find(provider, modelId);
    if (m) {
      const thresholdPercent = currentConfig.contextThresholdPercentOverrides?.[modelRef]
        ?? currentConfig.defaultContextThresholdPercent;

      if (thresholdPercent !== undefined && m.contextWindow) {
        const thresholdTokens = Math.floor((thresholdPercent / 100) * m.contextWindow);
        if (currentTokens > thresholdTokens) {
          continue; // Skip this model
        }
      }
    }
    // ... rest of logic
  }
}
```

**Problem**: The code only checks models in the current and higher tiers, but it doesn't force an escalation if ALL models in the decision tier fail the context threshold check. It should escalate to higher tiers if no models in the current tier meet the context requirements.

**Expected Behavior**: If a context threshold is exceeded and no models in the decision tier can handle it, the router should automatically escalate to higher tiers regardless of the heuristic decision.

### 2. Context Threshold Trigger Missing from Heuristic Analysis ❌
**Location**: `extensions/routing.ts` lines 108-158

**Issue**: The `analyzePrompt()` function doesn't include context threshold considerations in the heuristic analysis. According to the README, the context trigger should force high tier regardless of other factors, but this logic is missing from the heuristic analysis.

```typescript
// Current heuristic analysis in analyzePrompt()
if (pinnedTier) {
  tier = pinnedTier;
  reasoning = `Pinned to ${pinnedTier} tier via /router-pin.`;
} else {
  // ... existing heuristic logic
}
```

**Missing Logic**: The heuristic should check if the current context usage exceeds `defaultContextThresholdPercent` and force high tier if so.

**Expected Behavior**: Add context threshold check to the heuristic analysis before other rules.

### 3. Context Usage Estimation - Potential Inaccuracy ❌
**Location**: `extensions/provider.ts` lines 147-151

**Issue**: The context usage estimation relies on `getContextUsage()` which may not be available or accurate in all scenarios. The fallback behavior is unclear.

```typescript
let currentTokens = 0;
try {
  const usage = await state.lastExtensionContext?.getContextUsage();
  currentTokens = usage?.tokens ?? 0;
} catch {
  // ignore - this could mask important errors
}
```

**Problem**: If `getContextUsage()` fails or returns 0, the context threshold logic becomes ineffective. There should be a fallback estimation method.

**Expected Behavior**: Implement a more robust token estimation using the existing `estimateTokens()` function as a backup when `getContextUsage()` fails.

### 4. Tier Search Logic - Escalation Not Explicit ❌
**Location**: `extensions/provider.ts` lines 175-196

**Issue**: While the tier search logic correctly searches from current tier upwards, it doesn't explicitly handle the case where escalation is forced due to context or image requirements. The `upgradeReason` logic only captures the first escalation, not subsequent ones.

```typescript
if (t !== decision.tier) {
  upgradeReason = `Forced ${t} tier because ${decision.tier} tier lacks models supporting ${detectedImageInRecentContext ? 'images and ' : ''}${currentTokens} tokens.`;
}
```

**Problem**: If escalation happens multiple times (e.g., from low to medium to high), the reasoning only captures the first escalation step.

**Expected Behavior**: The reasoning should accurately reflect the full escalation path.

### 5. Context Threshold Override - Configuration Validation ❌
**Location**: `extensions/config.ts` lines 144-149

**Issue**: The configuration validation for `defaultContextThresholdPercent` doesn't ensure it's a reasonable value (e.g., between 1-100).

```typescript
const defaultContextThresholdPercent =
  typeof raw.defaultContextThresholdPercent === 'number' &&
  raw.defaultContextThresholdPercent > 0
    ? raw.defaultContextThresholdPercent
    : undefined;
```

**Problem**: Values like 200% or 0.1% would be accepted but might not make practical sense.

**Expected Behavior**: Add validation to ensure the percentage is within a reasonable range (e.g., 1-100).

## Recommendations

### 1. Fix Context Threshold Escalation Logic
```typescript
// In provider.ts, after the tier search loop
let selectedTier = decision.tier;
let selectedModelRef: string | undefined;
let upgradeReason: string | undefined;

// Check if we need to escalate due to context threshold
if (currentTokens > 0) {
  let contextCompatibleTier = decision.tier;
  for (const t of tiersToSearch) {
    const modelsInTier = [profile[t].model, ...(profile[t].fallbacks ?? [])];
    for (const modelRef of modelsInTier) {
      const { provider, modelId } = parseCanonicalModelRef(modelRef);
      const m = state.currentModelRegistry?.find(provider, modelId);
      if (m && currentConfig.contextThresholdPercentOverrides?.[modelRef] ?? currentConfig.defaultContextThresholdPercent) {
        const thresholdTokens = Math.floor(((currentConfig.contextThresholdPercentOverrides?.[modelRef] ?? currentConfig.defaultContextThresholdPercent) / 100) * m.contextWindow);
        if (currentTokens <= thresholdTokens) {
          contextCompatibleTier = t;
          break;
        }
      }
    }
  }
  if (contextCompatibleTier !== decision.tier) {
    selectedTier = contextCompatibleTier;
    upgradeReason = `Escalated to ${contextCompatibleTier} tier due to context threshold (${currentTokens} tokens)`;
  }
}
```

### 2. Add Context Threshold to Heuristic Analysis
```typescript
// In routing.ts, analyzePrompt function
if (pinnedTier) {
  tier = pinnedTier;
  reasoning = `Pinned to ${pinnedTier} tier via /router-pin.`;
} else {
  // Add context threshold check before other heuristics
  if (currentConfig.defaultContextThresholdPercent !== undefined && currentTokens > 0) {
    const thresholdTokens = Math.floor((currentConfig.defaultContextThresholdPercent / 100) * estimatedMaxContextWindow);
    if (currentTokens > thresholdTokens) {
      tier = 'high';
      reasoning = `Context threshold exceeded (${currentTokens} > ${thresholdTokens}), forcing high tier.`;
      return { suggestedTier: tier, reasoning, isRuleMatched: false };
    }
  }
  
  // ... existing heuristic logic
}
```

### 3. Improve Context Usage Estimation
```typescript
// In provider.ts
const getContextTokenEstimate = async (): Promise<number> => {
  try {
    const usage = await state.lastExtensionContext?.getContextUsage();
    return usage?.tokens ?? 0;
  } catch {
    // Fallback: estimate from context messages
    return context.messages.reduce((sum, m) => 
      sum + estimateTokens(extractTextFromContent(m.content)), 0);
  }
};

// Usage:
const currentTokens = await getContextTokenEstimate();
```

### 4. Add Configuration Validation
```typescript
// In config.ts
const validateContextThreshold = (value: number): number => {
  if (value < 1) return 1;
  if (value > 100) return 100;
  return value;
};

const defaultContextThresholdPercent =
  typeof raw.defaultContextThresholdPercent === 'number'
    ? validateContextThreshold(raw.defaultContextThresholdPercent)
    : undefined;
```

## Conclusion

The pi-model-router implementation is generally sound and follows the architecture well. The main issues are in the context threshold handling logic, particularly around escalation behavior and integration with the heuristic analysis. The tier-based model selection and image-aware routing are correctly implemented. The recommended fixes would improve the reliability and accuracy of the context threshold functionality while maintaining the existing clean architecture.