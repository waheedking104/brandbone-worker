// src/prompts/metaGenerator.js
export function buildMetaPrompt({ product, audience, goal, platform, format }) {
  return {
    systemPrompt: `You are a senior Meta Ads specialist. Write scroll-stopping, conversion-focused ad copy. Always native to the platform, never generic.`,
    userPrompt: `Create 3 ${platform === 'instagram' ? 'Instagram' : 'Facebook'} ad variations for:
Product/Service: ${product}
Target Audience: ${audience || 'broad audience'}
Objective: ${goal || 'conversions'}
Format: ${format || 'feed post'}

Output EXACTLY this format:

## Ad Variation 1
**Hook** (first line that stops scroll): 
**Primary Text** (125 chars recommended): 
**Headline** (27 chars max): 
**Description** (27 chars max): 
**CTA Button**: 
**Emotional Trigger**: 

## Ad Variation 2
[same format]

## Ad Variation 3
[same format]

**Audience Targeting**: 
**Creative Direction**: `
  }
}

// src/prompts/emailGenerator.js
export function buildEmailPrompt({ product, audience, goal, count, style }) {
  const num = Math.min(parseInt(count) || 5, 10)
  return {
    systemPrompt: `You are an email marketing expert. Write subject lines with 40%+ open rate potential. Avoid spam triggers.`,
    userPrompt: `Generate ${num} email subject lines for:
Product/Service: ${product}
Audience: ${audience || 'subscribers'}
Goal: ${goal || 'engagement'}
Style: ${style || 'mixed'}

For each, output EXACTLY:

**Subject ${1}**: [subject line]
- Type: [urgency/curiosity/benefit/question/social proof]
- Spam Risk: [Low/Medium]
- Preview Text: [50-char preview]

[repeat for all ${num}]

**Best Pick**: Subject [X] — [one sentence why]
**A/B Test Pair**: Subject [X] vs Subject [Y]`
  }
}

// src/prompts/agentDemo.js
export const AGENT_SYSTEM = `You are a senior digital marketing strategist. Be specific, actionable, use real numbers. Never be vague.`

export function buildAgentStepPrompt(stepType, goal) {
  const prompts = {
    strategy: `Create a complete campaign strategy for: "${goal}"
Include: Positioning angle, USP, key message, campaign hook, recommended channels, 30-day timeline.`,

    creative: `For goal: "${goal}" — Create 3 ad creatives.
Each: Format, Platform, Hook (first line), Body copy (2-3 sentences), CTA, Visual direction, Psychological trigger.`,

    audience: `For: "${goal}" — Define complete targeting:
Primary audience (demographics), 10 interests, 5 behaviors, 3 lookalike sources, negative audiences, budget split.`,

    email: `For: "${goal}" — Write 3-email follow-up sequence:
Email 1 (immediate): Subject, preview, body, CTA
Email 2 (day 3): Subject, preview, body, CTA
Email 3 (day 7 conversion): Subject, preview, body with objection handling, strong CTA`,

    export: `Compile complete campaign brief for: "${goal}"
Include: Executive summary, strategy, top 2 creatives, audience, channel mix, week-1 calendar, 5 KPIs, next steps.`
  }
  return { systemPrompt: AGENT_SYSTEM, userPrompt: prompts[stepType] || prompts.strategy }
}

export const AGENT_STEPS = [
  { number: 1, type: 'strategy',  label: 'Campaign Strategy'   },
  { number: 2, type: 'creative',  label: 'Ad Creatives'        },
  { number: 3, type: 'audience',  label: 'Audience Targeting'  },
  { number: 4, type: 'email',     label: 'Email Sequence'      },
  { number: 5, type: 'export',    label: 'Complete Brief'      }
]

