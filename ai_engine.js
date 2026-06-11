const dotenv = require('dotenv');
dotenv.config();

/**
 * Generates an AI nudge and assessment based on biometric and contextual user data.
 * @param {Object} data 
 * @param {number} data.heartRate
 * @param {number} data.sleepHours
 * @param {number} data.waterMl
 * @param {number} data.stressLevel
 * @param {number} data.fatigueScore
 * @param {Array<string>} data.hobbies
 * @param {Array<string>} data.wellnessGoals
 * @returns {Promise<{ nudge: string, targetHobby: string, assessment: string }>}
 */
async function analyzeStateAndGenerateNudge(data) {
  const { heartRate, sleepHours, waterMl, stressLevel, fatigueScore, hobbies = [], wellnessGoals = [] } = data;
  const apiKey = process.env.GEMINI_API_KEY;

  const hobbyList = hobbies.length > 0 ? hobbies.join(', ') : 'general stretching, listening to music';
  const goalList = wellnessGoals.length > 0 ? wellnessGoals.join(', ') : 'improve general wellness';

  // Construct the prompt
  const systemPrompt = `You are the BioSync AI Context Engine, a smart wellness guide. You analyze daily biometrics and context to return a single-sentence behavioral nudge and a short 2-3 sentence clinical-style assessment.
You must align recommendations with the user's hobbies (${hobbyList}) and wellness goals (${goalList}).
Your response MUST be JSON format with exactly three fields:
{
  "nudge": "A single-sentence, highly personalized, active behavioral nudge based on their state and one of their hobbies. Keep it short, actionable, and engaging.",
  "targetHobby": "The specific hobby from the list that this nudge utilizes.",
  "assessment": "A 2-3 sentence overview of their biometric state (e.g., discussing high heart rate, fatigue levels, dehydration) and the physiological rationale for the suggestion."
}`;

  const userPrompt = `Biometrics & Context Input:
- Heart Rate: ${heartRate} BPM (resting threshold: 100)
- Sleep: ${sleepHours} hours
- Water Intake: ${waterMl} ml
- Stress Level: ${stressLevel}/10
- Webcam Fatigue Score: ${fatigueScore}/10

Hobby Options: [${hobbyList}]
Wellness Goals: [${goalList}]

Please generate the JSON response.`;

  if (apiKey && apiKey !== 'YOUR_GEMINI_API_KEY_HERE') {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `${systemPrompt}\n\n${userPrompt}`
            }]
          }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.7,
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Gemini API returned status ${response.status}`);
      }

      const resData = await response.json();
      const rawText = resData.candidates[0].content.parts[0].text;
      
      let cleanJsonText = rawText.trim();
      if (cleanJsonText.startsWith('```')) {
        cleanJsonText = cleanJsonText.replace(/^```(json)?/, '').replace(/```$/, '').trim();
      }

      const parsed = JSON.parse(cleanJsonText);
      if (parsed.nudge && parsed.assessment) {
        return {
          nudge: parsed.nudge,
          targetHobby: parsed.targetHobby || (hobbies[0] || 'general rest'),
          assessment: parsed.assessment
        };
      }
    } catch (err) {
      console.warn('Gemini API call failed, falling back to local engine:', err.message);
    }
  }

  // Fallback Rule-Based Engine (High Fidelity, Contextual)
  return generateDeterministicNudge(data, hobbies, wellnessGoals);
}

function generateDeterministicNudge(data, hobbies, wellnessGoals) {
  const { heartRate, sleepHours, waterMl, stressLevel, fatigueScore } = data;
  
  // Select main hobby to target
  const primaryHobby = hobbies[0] || 'general stretching';
  const secondaryHobby = hobbies[1] || hobbies[0] || 'deep breathing';

  let nudge = "";
  let targetHobby = primaryHobby;
  let assessment = "";

  // 1. Identify primary physical anomalies
  const isDehydrated = waterMl < 1500;
  const isSleepDeprived = sleepHours < 6.5;
  const isStressed = stressLevel >= 7;
  const isHeartHigh = heartRate > 100;
  const isFatigued = fatigueScore >= 6;

  // Generate assessment based on numbers
  assessment = `Your biometrics indicate `;
  const stateConditions = [];
  if (isHeartHigh) stateConditions.push(`an elevated pulse of ${heartRate} BPM`);
  if (isStressed) stateConditions.push(`high subjective stress levels (${stressLevel}/10)`);
  if (isFatigued) stateConditions.push(`noticeable facial fatigue indicators (score: ${fatigueScore}/10)`);
  if (isSleepDeprived) stateConditions.push(`sleep deficit (${sleepHours}h slept)`);
  if (isDehydrated) stateConditions.push(`insufficient hydration (${waterMl}ml)`);

  if (stateConditions.length === 0) {
    assessment += `a highly balanced state with normal heart rate (${heartRate} BPM) and optimal recovery. Physiological biomarkers are stable.`;
  } else {
    assessment += stateConditions.slice(0, -1).join(', ') + (stateConditions.length > 1 ? ', and ' : '') + stateConditions[stateConditions.length - 1] + '. ';
    assessment += `This combination places moderate strain on your autonomic nervous system, highlighting the need for active recovery.`;
  }

  // Generate nudge matching hobby + stress/fatigue state
  const hobbyMatch = primaryHobby.toLowerCase();

  if (isStressed || isHeartHigh) {
    targetHobby = primaryHobby;
    if (hobbyMatch.includes('coding') || hobbyMatch.includes('gaming')) {
      // Screen based, switch to secondary if screenless
      const subMatch = secondaryHobby.toLowerCase();
      if (!subMatch.includes('coding') && !subMatch.includes('gaming')) {
        targetHobby = secondaryHobby;
      }
    }

    const lowStressHobby = targetHobby.toLowerCase();
    if (lowStressHobby.includes('guitar') || lowStressHobby.includes('music')) {
      nudge = `Tune down your stress by playing a slow, relaxing chord progression on your guitar for 10 minutes.`;
    } else if (lowStressHobby.includes('basketball') || lowStressHobby.includes('sports') || lowStressHobby.includes('run')) {
      nudge = `Take a break from your current tasks and shoot 15 light free-throws to release muscular tension.`;
    } else if (lowStressHobby.includes('reading') || lowStressHobby.includes('book')) {
      nudge = `Unwind your mind by reading two pages of your favorite book in a comfortable, quiet setting.`;
    } else if (lowStressHobby.includes('cooking') || lowStressHobby.includes('food')) {
      nudge = `Step away from screens and brew a warm cup of herbal tea, focusing on the sensory prep process.`;
    } else if (lowStressHobby.includes('coding')) {
      nudge = `Take a 10-minute break from compiling, shut the IDE, and sketch out a clean flow-chart on physical paper.`;
    } else {
      nudge = `Close your eyes for 5 minutes and practice a 4-7-8 breathing sequence to regulate your elevated heart rate.`;
    }
  } else if (isFatigued || isSleepDeprived) {
    targetHobby = primaryHobby;
    const lowFatigueHobby = targetHobby.toLowerCase();
    if (lowFatigueHobby.includes('guitar') || lowFatigueHobby.includes('music')) {
      nudge = `Re-energize your brain by strumming a simple, upbeat melody on your guitar without looking at charts.`;
    } else if (lowFatigueHobby.includes('coding') || lowFatigueHobby.includes('gaming')) {
      // Screen-based, need offline
      targetHobby = secondaryHobby;
      const subHobby = targetHobby.toLowerCase();
      if (subHobby.includes('reading')) {
        nudge = `Rest your eyes from screen glare: close them for 5 minutes, then read a printed page under soft lighting.`;
      } else {
        nudge = `Hydrate with a tall glass of ice water, stretch your neck, and do a light physical walk.`;
      }
    } else if (lowFatigueHobby.includes('cooking')) {
      nudge = `Prepare a quick, nutrient-dense snack (like sliced apple with almonds) to boost your dipping glucose levels.`;
    } else if (lowFatigueHobby.includes('basketball')) {
      nudge = `Perform some gentle ball-handling drills or light stretches to increase blood flow and combat drowsiness.`;
    } else {
      nudge = `Drink 300ml of water and take a 15-minute power walk to re-oxygenate your system.`;
    }
  } else {
    // Normal balanced state
    targetHobby = primaryHobby;
    const normHobby = targetHobby.toLowerCase();
    if (normHobby.includes('guitar')) {
      nudge = `Your focus metrics are optimal—it's a great time to practice that challenging guitar solo you've been working on!`;
    } else if (normHobby.includes('coding')) {
      nudge = `Cognitive clarity is peak right now: tackle your most complex code block or plan a new system feature.`;
    } else if (normHobby.includes('basketball')) {
      nudge = `Energy levels are high! Head to the court for a high-intensity dribbling or shooting drill session.`;
    } else if (normHobby.includes('cooking')) {
      nudge = `Your mind is sharp: try prepping a fresh, healthy recipe that challenges your culinary skills today.`;
    } else if (normHobby.includes('gaming')) {
      nudge = `Perfect time for a quick strategy match: your reflexes and heart-rate recovery are in peak form.`;
    } else {
      nudge = `You are fully synced! Take advantage of this balanced state to dive deep into ${targetHobby}.`;
    }
  }

  // Inject advice about water or sleep if severe
  if (isDehydrated && !nudge.includes('water') && !nudge.includes('tea')) {
    nudge += ` Remember to drink a large glass of water right now to replenish your fluid levels.`;
  }

  return { nudge, targetHobby, assessment };
}

module.exports = {
  analyzeStateAndGenerateNudge
};
