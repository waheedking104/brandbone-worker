// src/prompts/adsGenerator.js
export function buildAdsPrompt({ product, audience, goal, tone }) {
  return {
    systemPrompt: `You are an elite Google Ads copywriter. Always stay within character limits. Output structured, copy-paste ready ad variations.`,
    userPrompt: `Create 3 Google Ads variations for:
Product/Service: ${product}
Target Audience: ${audience || 'general consumers'}
Campaign Goal: ${goal || 'conversions'}
Tone: ${tone || 'professional'}

Output EXACTLY this format for each:

## Ad Variation 1
**Headline 1** (max 30 chars): 
**Headline 2** (max 30 chars): 
**Headline 3** (max 30 chars): 
**Description 1** (max 90 chars): 
**Description 2** (max 90 chars): 

## Ad Variation 2
[same format]

## Ad Variation 3
[same format]

**Recommended Keywords** (6-8): 
**Negative Keywords** (3-4): 
**Bid Strategy**: `
  }
}

