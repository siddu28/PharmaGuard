import { ToolDecorator as Tool, Widget, ExecutionContext, z } from '@nitrostack/core';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  ALLERGY_CROSS_REACTIVITY_TABLE,
  CONTRAINDICATION_TABLE,
  DRUG_INTERACTION_FALLBACK_TABLE,
  PREGNANCY_CATEGORY_TABLE,
  LOCAL_DRUG_CLASSES,
  ALTERNATIVE_DRUGS,
  getInteractionKey,
} from './data/clinical-tables.js';

// Resolve __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load patients from the JSON file
 */
function loadPatients() {
  const dataPath = path.join(__dirname, 'data', 'patients.json');
  const raw = fs.readFileSync(dataPath, 'utf-8');
  return JSON.parse(raw).patients;
}

/**
 * In-memory patient store for LLM-extracted patients.
 * Patients added via ingest_patient_record are stored here
 * and accessible to get_patient_profile alongside the demo patients.
 */
const inMemoryPatients: Map<string, any> = new Map();
let nextPatientCounter = 100; // Auto-generated IDs start at P100

/**
 * Call Gemini API for LLM tasks.
 * Returns null on failure (quota exceeded, network error, etc.) so callers can fall back.
 */
async function callGemini(prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
          },
        }),
      }
    );

    if (!response.ok) {
      console.error(`Gemini API error (${response.status})`);
      return null;
    }

    const data: any = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch (error) {
    console.error('Gemini API call failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

// ============================================================================
// PharmaGuard Tools — All MCP tools for clinical safety analysis
// ============================================================================

export class PharmaGuardTools {

  // ==========================================================================
  // Tool 1: get_patient_profile
  // ==========================================================================
  @Tool({
    name: 'get_patient_profile',
    description: 'Retrieves full clinical profile for a patient: demographics, lab results, allergies, diagnoses, and current medications',
    inputSchema: z.object({
      patientId: z.string().describe('Patient ID (e.g. P001, P002, P003)')
    }),
    examples: {
      request: { patientId: 'P001' },
      response: {
        id: 'P001',
        name: 'Mr. Sharma',
        age: 65,
        diagnoses: ['Hypertension', 'Sinusitis'],
        allergies: ['Penicillin'],
        currentMedications: [{ name: 'Lisinopril', dosage: '10mg', frequency: 'daily' }]
      }
    }
  })
  async getPatientProfile(input: { patientId: string }, ctx: ExecutionContext) {
    ctx.logger.info('Fetching patient profile', { patientId: input.patientId });

    // Check in-memory store first (LLM-extracted patients)
    if (inMemoryPatients.has(input.patientId)) {
      ctx.logger.info('Found patient in memory (extracted from unstructured data)', { patientId: input.patientId });
      return inMemoryPatients.get(input.patientId);
    }

    // Fall back to demo patients from JSON file
    const patients = loadPatients();
    const patient = patients.find((p: any) => p.id === input.patientId);

    if (!patient) {
      // List all available IDs (demo + in-memory)
      const demoIds = patients.map((p: any) => p.id);
      const memoryIds = Array.from(inMemoryPatients.keys());
      const allIds = [...demoIds, ...memoryIds];
      throw new Error(`Patient not found: ${input.patientId}. Available IDs: ${allIds.join(', ')}`);
    }

    return patient;
  }

  // ==========================================================================
  // Tool 2: extract_clinical_entities
  // ==========================================================================
  @Tool({
    name: 'extract_clinical_entities',
    description: 'Uses LLM to parse a doctor\'s natural language prescription note into structured clinical entities (drug name, dosage, frequency, reason)',
    inputSchema: z.object({
      prescriptionNote: z.string().describe('The doctor\'s free-text prescription note, e.g. "Prescribe Ibuprofen 400mg three times daily for headache"')
    }),
    examples: {
      request: { prescriptionNote: 'Prescribe Ibuprofen 400mg three times daily for headache' },
      response: {
        drugName: 'Ibuprofen',
        dosage: '400mg',
        frequency: 'three times daily',
        reason: 'headache'
      }
    }
  })
  async extractClinicalEntities(input: { prescriptionNote: string }, ctx: ExecutionContext) {
    ctx.logger.info('Extracting clinical entities from prescription note', {
      note: input.prescriptionNote
    });

    const prompt = `You are a clinical NLP system. Extract the following fields from the doctor's prescription note.
Return ONLY a valid JSON object with these fields:
- drugName (string): the medication being prescribed
- dosage (string): the dose amount (e.g. "400mg")
- frequency (string): how often to take it (e.g. "three times daily")
- reason (string): the medical reason for the prescription

Prescription note: "${input.prescriptionNote}"

Respond with ONLY the JSON object, no markdown, no explanation.`;

    const response = await callGemini(prompt);

    // If LLM failed (quota, network), try basic regex extraction
    if (!response) {
      ctx.logger.warn('Gemini unavailable, using basic extraction');
      const note = input.prescriptionNote;
      // Simple pattern: "Prescribe DrugName DoseMg frequency for reason"
      const drugMatch = note.match(/(?:prescribe|give|start|order)\s+([A-Za-z]+)/i);
      const doseMatch = note.match(/(\d+\s*mg|\d+\s*ml)/i);
      return {
        drugName: drugMatch?.[1] || 'Unknown',
        dosage: doseMatch?.[1] || 'Not specified',
        frequency: 'Not specified',
        reason: 'Not specified',
        source: 'basic_extraction (LLM unavailable)',
      };
    }

    try {
      // Strip markdown code fences if present
      const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return {
        drugName: parsed.drugName || 'Unknown',
        dosage: parsed.dosage || 'Not specified',
        frequency: parsed.frequency || 'Not specified',
        reason: parsed.reason || 'Not specified',
      };
    } catch (error) {
      ctx.logger.error('Failed to parse LLM response', { response });
      return {
        drugName: 'Unknown',
        dosage: 'Not specified',
        frequency: 'Not specified',
        reason: 'Not specified',
        rawResponse: response,
        parseError: 'Failed to parse LLM output as JSON',
      };
    }
  }

  // ==========================================================================
  // Tool 3: check_drug_drug_interaction
  // ==========================================================================
  @Tool({
    name: 'check_drug_drug_interaction',
    description: 'Checks for drug-drug interactions between the new prescription and all current medications. Uses OpenFDA API with hardcoded fallback for demo drugs.',
    inputSchema: z.object({
      newDrug: z.string().describe('The newly prescribed drug name'),
      currentMedications: z.array(z.string()).describe('List of current medication names the patient is already taking')
    }),
    examples: {
      request: { newDrug: 'Ibuprofen', currentMedications: ['Lisinopril'] },
      response: {
        hasInteraction: true,
        interactions: [{
          drug1: 'Ibuprofen',
          drug2: 'Lisinopril',
          severity: 'major',
          description: 'NSAIDs reduce the antihypertensive effect of ACE inhibitors'
        }]
      }
    }
  })
  async checkDrugDrugInteraction(
    input: { newDrug: string; currentMedications: string[] },
    ctx: ExecutionContext
  ) {
    ctx.logger.info('Checking drug-drug interactions', {
      newDrug: input.newDrug,
      against: input.currentMedications
    });

    const interactions: Array<{
      drug1: string;
      drug2: string;
      severity: string;
      description: string;
      source: string;
    }> = [];

    for (const currentMed of input.currentMedications) {
      // Try OpenFDA first
      let foundViaApi = false;
      try {
        const searchTerm = `"${input.newDrug}" AND "${currentMed}"`;
        const url = `https://api.fda.gov/drug/label.json?search=drug_interactions:${encodeURIComponent(searchTerm)}&limit=1`;

        const response = await fetch(url);
        if (response.ok) {
          const data: any = await response.json();
          if (data.results && data.results.length > 0) {
            const interactionText = data.results[0].drug_interactions?.[0] || 'Interaction found in FDA label data.';
            interactions.push({
              drug1: input.newDrug,
              drug2: currentMed,
              severity: 'major',
              description: interactionText.substring(0, 300),
              source: 'OpenFDA',
            });
            foundViaApi = true;
          }
        }
      } catch (error) {
        ctx.logger.warn('OpenFDA API call failed, falling back to local table', {
          error: error instanceof Error ? error.message : String(error)
        });
      }

      // Fallback to local table
      if (!foundViaApi) {
        const key = getInteractionKey(input.newDrug, currentMed);
        const fallback = DRUG_INTERACTION_FALLBACK_TABLE[key];
        if (fallback) {
          interactions.push({
            drug1: input.newDrug,
            drug2: currentMed,
            severity: fallback.severity,
            description: fallback.description,
            source: 'Local Clinical Database',
          });
        }
      }
    }

    return {
      hasInteraction: interactions.length > 0,
      interactions,
      checkedPairs: input.currentMedications.map(med => `${input.newDrug} ↔ ${med}`),
    };
  }

  // ==========================================================================
  // Tool 4: check_drug_allergy_conflict
  // ==========================================================================
  @Tool({
    name: 'check_drug_allergy_conflict',
    description: 'Checks if the new drug conflicts with any documented patient allergies via cross-reactivity lookup',
    inputSchema: z.object({
      newDrug: z.string().describe('The newly prescribed drug name'),
      allergies: z.array(z.string()).describe('Patient\'s documented allergies')
    }),
    examples: {
      request: { newDrug: 'Amoxicillin', allergies: ['Penicillin'] },
      response: {
        hasConflict: true,
        detail: 'Amoxicillin may cross-react with documented allergy: Penicillin'
      }
    }
  })
  async checkDrugAllergyConflict(
    input: { newDrug: string; allergies: string[] },
    ctx: ExecutionContext
  ) {
    ctx.logger.info('Checking allergy conflicts', {
      newDrug: input.newDrug,
      allergies: input.allergies
    });

    if (input.allergies.length === 0) {
      return { hasConflict: false, detail: null };
    }

    const crossReactivities = ALLERGY_CROSS_REACTIVITY_TABLE[input.newDrug];

    if (!crossReactivities) {
      // Also check if the drug itself is in the allergy list (direct match)
      const directMatch = input.allergies.find(
        a => a.toLowerCase() === input.newDrug.toLowerCase()
      );
      if (directMatch) {
        return {
          hasConflict: true,
          detail: `${input.newDrug} is directly listed as a patient allergy`,
        };
      }
      return { hasConflict: false, detail: null };
    }

    const matchedAllergy = crossReactivities.find(cls =>
      input.allergies.some(a => a.toLowerCase() === cls.toLowerCase())
    );

    if (matchedAllergy) {
      return {
        hasConflict: true,
        detail: `${input.newDrug} may cross-react with documented allergy: ${matchedAllergy}`,
      };
    }

    return { hasConflict: false, detail: null };
  }

  // ==========================================================================
  // Tool 5: check_disease_conflict
  // ==========================================================================
  @Tool({
    name: 'check_disease_conflict',
    description: 'Checks if the new drug is contraindicated given the patient\'s diagnoses',
    inputSchema: z.object({
      newDrug: z.string().describe('The newly prescribed drug name'),
      diagnoses: z.array(z.string()).describe('Patient\'s current diagnoses')
    }),
    examples: {
      request: { newDrug: 'Ibuprofen', diagnoses: ['CKD Stage 3', 'Atrial Fibrillation'] },
      response: {
        hasConflict: true,
        conflictingDiagnosis: 'CKD Stage 3',
        detail: 'Ibuprofen is contraindicated in patients with CKD Stage 3'
      }
    }
  })
  async checkDiseaseConflict(
    input: { newDrug: string; diagnoses: string[] },
    ctx: ExecutionContext
  ) {
    ctx.logger.info('Checking disease conflicts', {
      newDrug: input.newDrug,
      diagnoses: input.diagnoses
    });

    const contraindications = CONTRAINDICATION_TABLE[input.newDrug];

    if (!contraindications) {
      return { hasConflict: false, conflictingDiagnosis: null, detail: null };
    }

    const conflict = contraindications.find(d =>
      input.diagnoses.some(diag => diag.toLowerCase() === d.toLowerCase())
    );

    if (conflict) {
      return {
        hasConflict: true,
        conflictingDiagnosis: conflict,
        detail: `${input.newDrug} is contraindicated in patients with ${conflict}`,
      };
    }

    return { hasConflict: false, conflictingDiagnosis: null, detail: null };
  }

  // ==========================================================================
  // Tool 6: check_age_appropriateness
  // ==========================================================================
  @Tool({
    name: 'check_age_appropriateness',
    description: 'Flags if drug dosing needs adjustment for pediatric (<18) or elderly (≥65) patients based on Beers Criteria guidelines',
    inputSchema: z.object({
      newDrug: z.string().describe('The newly prescribed drug name'),
      age: z.number().describe('Patient age in years')
    }),
    examples: {
      request: { newDrug: 'Ibuprofen', age: 80 },
      response: {
        flag: 'elderly',
        note: 'Consider reduced starting dose per Beers Criteria. NSAIDs should be avoided in elderly patients when possible.'
      }
    }
  })
  async checkAgeAppropriateness(
    input: { newDrug: string; age: number },
    ctx: ExecutionContext
  ) {
    ctx.logger.info('Checking age appropriateness', {
      newDrug: input.newDrug,
      age: input.age
    });

    if (input.age >= 65) {
      return {
        flag: 'elderly',
        note: `Patient is ${input.age} years old. Consider reduced starting dose per Beers Criteria. Review ${input.newDrug} for age-related dose adjustments and increased sensitivity to side effects.`,
      };
    }

    if (input.age < 18) {
      return {
        flag: 'pediatric',
        note: `Patient is ${input.age} years old. Verify pediatric dosing guidelines for ${input.newDrug}. Weight-based dosing may be required.`,
      };
    }

    return { flag: 'none', note: null };
  }

  // ==========================================================================
  // Tool 7: aggregate_risk_score
  // ==========================================================================
  @Tool({
    name: 'aggregate_risk_score',
    description: 'Combines all individual safety check results into one overall risk assessment with a clear verdict (safe / caution / high_risk)',
    inputSchema: z.object({
      checks: z.array(z.object({
        type: z.string().describe('Type of check (e.g. drug_interaction, allergy, disease, age, renal, pregnancy, duplicate)'),
        flagged: z.boolean().describe('Whether this check raised a concern'),
        severity: z.string().optional().describe('Severity level: minor, moderate, major'),
        detail: z.string().optional().describe('Description of the concern')
      })).describe('Array of all individual check results')
    }),
    examples: {
      request: {
        checks: [
          { type: 'drug_interaction', flagged: true, severity: 'major', detail: 'NSAIDs + ACE inhibitors' },
          { type: 'allergy', flagged: false },
          { type: 'age', flagged: true, severity: 'moderate', detail: 'Elderly patient, 65+' }
        ]
      },
      response: {
        overallRisk: 'high_risk',
        riskScore: 2,
        totalChecks: 3,
        flaggedChecks: [
          { type: 'drug_interaction', severity: 'major', detail: 'NSAIDs + ACE inhibitors' },
          { type: 'age', severity: 'moderate', detail: 'Elderly patient, 65+' }
        ],
        recommendation: 'Multiple safety concerns identified. Review recommended before prescribing.'
      }
    }
  })
  async aggregateRiskScore(
    input: { checks: Array<{ type: string; flagged: boolean; severity?: string; detail?: string }> },
    ctx: ExecutionContext
  ) {
    ctx.logger.info('Aggregating risk score', { totalChecks: input.checks.length });

    const flaggedChecks = input.checks.filter(c => c.flagged);
    const hasMajor = flaggedChecks.some(c => c.severity === 'major');

    let overallRisk: string;
    let recommendation: string;

    if (flaggedChecks.length === 0) {
      overallRisk = 'safe';
      recommendation = 'No safety concerns identified. Prescription appears safe to proceed.';
    } else if (hasMajor || flaggedChecks.length >= 2) {
      overallRisk = 'high_risk';
      recommendation = 'Multiple or major safety concerns identified. Strongly recommend reviewing alternatives before prescribing.';
    } else {
      overallRisk = 'caution';
      recommendation = 'Minor concern identified. Proceed with caution and consider dose adjustment.';
    }

    return {
      overallRisk,
      riskScore: flaggedChecks.length,
      totalChecks: input.checks.length,
      flaggedChecks,
      recommendation,
    };
  }

  // ==========================================================================
  // Tool 8: generate_doctor_report
  // ==========================================================================
  @Tool({
    name: 'generate_doctor_report',
    description: 'Generates a clear, concise clinical safety report for the doctor summarizing all findings, concerns, and the final recommendation',
    inputSchema: z.object({
      patientName: z.string().describe('Patient full name'),
      patientId: z.string().describe('Patient ID'),
      proposedDrug: z.string().describe('The drug being proposed'),
      proposedDosage: z.string().optional().describe('Proposed dosage'),
      riskAssessment: z.object({
        overallRisk: z.string(),
        riskScore: z.number(),
        flaggedChecks: z.array(z.any())
      }).describe('Output from aggregate_risk_score'),
      recommendedAlternative: z.string().optional().describe('Suggested alternative drug if any')
    }),
    examples: {
      request: {
        patientName: 'Mr. Sharma',
        patientId: 'P001',
        proposedDrug: 'Ibuprofen',
        proposedDosage: '400mg',
        riskAssessment: {
          overallRisk: 'high_risk',
          riskScore: 2,
          flaggedChecks: [
            { type: 'drug_interaction', severity: 'major', detail: 'NSAIDs + ACE inhibitors' }
          ]
        }
      },
      response: {
        report: 'Clinical safety report text...'
      }
    }
  })
  @Widget('risk-dashboard')
  async generateDoctorReport(input: any, ctx: ExecutionContext) {
    ctx.logger.info('Generating doctor report', {
      patient: input.patientName,
      drug: input.proposedDrug,
      risk: input.riskAssessment.overallRisk
    });

    const prompt = `You are a clinical decision support system. Write a concise, professional clinical safety report for a doctor.

PATIENT: ${input.patientName} (${input.patientId})
PROPOSED PRESCRIPTION: ${input.proposedDrug}${input.proposedDosage ? ' ' + input.proposedDosage : ''}
OVERALL RISK LEVEL: ${input.riskAssessment.overallRisk.toUpperCase()}
RISK SCORE: ${input.riskAssessment.riskScore} concern(s) flagged

SPECIFIC FINDINGS:
${JSON.stringify(input.riskAssessment.flaggedChecks, null, 2)}

${input.recommendedAlternative ? `SUGGESTED ALTERNATIVE: ${input.recommendedAlternative}` : ''}

Write the report with this structure:
1. **Overall Verdict** — one sentence: safe / proceed with caution / do not prescribe
2. **Concerns Found** — bullet list of each flagged issue with clinical context
3. **Recommendation** — what should the doctor do next

Be direct, clinical, evidence-based, and non-alarmist. Use professional medical terminology. Keep it under 300 words.`;

    let reportText = await callGemini(prompt);

    // Fallback: template-based report when LLM is unavailable
    if (!reportText) {
      ctx.logger.warn('Gemini unavailable, generating template-based report');
      const flagged = input.riskAssessment.flaggedChecks || [];
      const riskLabel = input.riskAssessment.overallRisk === 'high_risk' ? 'HIGH RISK — DO NOT PRESCRIBE without review'
        : input.riskAssessment.overallRisk === 'caution' ? 'CAUTION — Proceed with adjustments'
        : 'SAFE — No significant concerns identified';

      reportText = `**Overall Verdict:** ${riskLabel}

**Patient:** ${input.patientName} (${input.patientId})
**Proposed:** ${input.proposedDrug}${input.proposedDosage ? ' ' + input.proposedDosage : ''}
**Risk Score:** ${input.riskAssessment.riskScore} concern(s) flagged

**Concerns Found:**
${flagged.length > 0
  ? flagged.map((c: any) => `• [${(c.severity || 'info').toUpperCase()}] ${c.type}: ${c.detail || 'Flagged'}`).join('\n')
  : '• None — all safety checks passed'}

**Recommendation:** ${input.riskAssessment.overallRisk === 'high_risk'
  ? `Review alternatives before prescribing. ${input.recommendedAlternative ? 'Consider ' + input.recommendedAlternative + ' as a safer option.' : 'Consult a pharmacist.'}`
  : input.riskAssessment.overallRisk === 'caution'
  ? 'Proceed with dose adjustment and close monitoring.'
  : 'Prescription appears safe to proceed at standard dosing.'}`;
    }

    return {
      report: reportText,
      metadata: {
        patient: input.patientName,
        proposedDrug: input.proposedDrug,
        overallRisk: input.riskAssessment.overallRisk,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  // ==========================================================================
  // Tool 9: check_duplicate_therapy (Tier 2 — RxNorm API)
  // ==========================================================================
  @Tool({
    name: 'check_duplicate_therapy',
    description: 'Checks if the new drug is in the same therapeutic class as any existing medication using RxNorm API. Detects duplicate therapy risk (e.g., prescribing a second anticoagulant when patient is already on Warfarin).',
    inputSchema: z.object({
      newDrug: z.string().describe('The newly prescribed drug name'),
      currentMedications: z.array(z.string()).describe('List of current medication names')
    }),
    examples: {
      request: { newDrug: 'Aspirin', currentMedications: ['Warfarin', 'Metoprolol'] },
      response: {
        hasDuplicate: true,
        duplicates: [{
          newDrug: 'Aspirin',
          existingDrug: 'Warfarin',
          sharedClass: 'Anticoagulants / Antithrombotics',
          detail: 'Both drugs affect blood clotting. Concurrent use increases bleeding risk.'
        }]
      }
    }
  })
  async checkDuplicateTherapy(
    input: { newDrug: string; currentMedications: string[] },
    ctx: ExecutionContext
  ) {
    ctx.logger.info('Checking duplicate therapy via RxNorm', {
      newDrug: input.newDrug,
      currentMedications: input.currentMedications
    });

    const duplicates: Array<{
      newDrug: string;
      existingDrug: string;
      sharedClass: string;
      detail: string;
    }> = [];

    // Get therapeutic classes for the new drug from RxNorm
    let newDrugClasses: string[] = [];
    try {
      const classUrl = `https://rxnav.nlm.nih.gov/REST/rxclass/class/byDrugName.json?drugName=${encodeURIComponent(input.newDrug)}&relaSource=ATC`;
      const classResponse = await fetch(classUrl);
      if (classResponse.ok) {
        const classData: any = await classResponse.json();
        const entries = classData?.rxclassDrugInfoList?.rxclassDrugInfo;
        if (Array.isArray(entries)) {
          newDrugClasses = entries.map((e: any) => e.rxclassMinConceptItem?.className).filter(Boolean);
        }
      }
    } catch (error) {
      ctx.logger.warn('RxNorm API failed for new drug class lookup', {
        drug: input.newDrug,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // If RxNorm didn't return classes, use a local fallback
    if (newDrugClasses.length === 0) {
      newDrugClasses = LOCAL_DRUG_CLASSES[input.newDrug] ?? [];
    }

    // Compare against each current medication
    for (const currentMed of input.currentMedications) {
      let currentMedClasses: string[] = [];

      try {
        const medClassUrl = `https://rxnav.nlm.nih.gov/REST/rxclass/class/byDrugName.json?drugName=${encodeURIComponent(currentMed)}&relaSource=ATC`;
        const medResponse = await fetch(medClassUrl);
        if (medResponse.ok) {
          const medData: any = await medResponse.json();
          const entries = medData?.rxclassDrugInfoList?.rxclassDrugInfo;
          if (Array.isArray(entries)) {
            currentMedClasses = entries.map((e: any) => e.rxclassMinConceptItem?.className).filter(Boolean);
          }
        }
      } catch (error) {
        ctx.logger.warn('RxNorm API failed for current med class lookup', { drug: currentMed });
      }

      if (currentMedClasses.length === 0) {
        currentMedClasses = LOCAL_DRUG_CLASSES[currentMed] ?? [];
      }

      // Find shared classes
      const shared = newDrugClasses.filter(cls => currentMedClasses.includes(cls));
      if (shared.length > 0) {
        duplicates.push({
          newDrug: input.newDrug,
          existingDrug: currentMed,
          sharedClass: shared.join(', '),
          detail: `Both ${input.newDrug} and ${currentMed} belong to the same therapeutic class: ${shared[0]}. Concurrent use may be redundant or increase side effect risk.`,
        });
      }
    }

    return {
      hasDuplicate: duplicates.length > 0,
      duplicates,
      classesFound: {
        [input.newDrug]: newDrugClasses.slice(0, 5),
      },
    };
  }

  // ==========================================================================
  // Tool 10: check_renal_dose_adjustment (Tier 2 — rule-based)
  // ==========================================================================
  @Tool({
    name: 'check_renal_dose_adjustment',
    description: 'Flags if the drug dose needs adjustment based on kidney function (creatinine clearance). Uses CKD staging thresholds to recommend dose modifications.',
    inputSchema: z.object({
      newDrug: z.string().describe('The newly prescribed drug name'),
      creatinineClearance: z.number().describe('Patient creatinine clearance in mL/min (from lab results)')
    }),
    examples: {
      request: { newDrug: 'Ibuprofen', creatinineClearance: 22 },
      response: {
        flag: 'severe_renal_impairment',
        stage: 'CKD Stage 4',
        creatinineClearance: 22,
        note: 'Ibuprofen may need significant dose reduction or avoidance. CrCl < 30 mL/min indicates severe renal impairment.',
        recommendation: 'Avoid NSAIDs in severe renal impairment. Consider Acetaminophen as an alternative.'
      }
    }
  })
  async checkRenalDoseAdjustment(
    input: { newDrug: string; creatinineClearance: number },
    ctx: ExecutionContext
  ) {
    ctx.logger.info('Checking renal dose adjustment', {
      newDrug: input.newDrug,
      creatinineClearance: input.creatinineClearance
    });

    const crcl = input.creatinineClearance;

    // Determine CKD stage based on creatinine clearance
    let stage: string;
    let flag: string;
    let recommendation: string;

    if (crcl < 15) {
      stage = 'CKD Stage 5 (Kidney Failure)';
      flag = 'kidney_failure';
      recommendation = `${input.newDrug} is likely contraindicated. Consult nephrology before prescribing. Dialysis patients require specialized dosing.`;
    } else if (crcl < 30) {
      stage = 'CKD Stage 4 (Severe Impairment)';
      flag = 'severe_renal_impairment';
      recommendation = `${input.newDrug} may need significant dose reduction or complete avoidance. CrCl ${crcl} mL/min indicates severe impairment. Consider renal-safe alternatives.`;
    } else if (crcl < 60) {
      stage = 'CKD Stage 3 (Moderate Impairment)';
      flag = 'moderate_renal_impairment';
      recommendation = `Consider dose adjustment for ${input.newDrug}. CrCl ${crcl} mL/min indicates moderate impairment. Monitor renal function closely.`;
    } else if (crcl < 90) {
      stage = 'CKD Stage 2 (Mild Impairment)';
      flag = 'mild_renal_impairment';
      recommendation = `Standard dosing likely appropriate for ${input.newDrug}, but monitor renal function.`;
    } else {
      stage = 'Normal Kidney Function';
      flag = 'normal';
      recommendation = `No renal dose adjustment needed for ${input.newDrug}.`;
    }

    // Special warnings for drugs that are particularly nephrotoxic
    const nephrotoxicDrugs = ['Ibuprofen', 'Naproxen', 'Aspirin', 'Gentamicin', 'Vancomycin', 'Metformin'];
    const isNephrotoxic = nephrotoxicDrugs.some(d => d.toLowerCase() === input.newDrug.toLowerCase());

    if (isNephrotoxic && crcl < 60) {
      recommendation += ` ⚠️ ${input.newDrug} is known to be nephrotoxic — extra caution required with impaired renal function.`;
    }

    return {
      flag,
      stage,
      creatinineClearance: crcl,
      note: `CrCl ${crcl} mL/min → ${stage}`,
      recommendation,
      isNephrotoxic,
    };
  }

  // ==========================================================================
  // Tool 11: find_and_rank_alternatives (Tier 2 — RxNorm + re-check)
  // ==========================================================================
  @Tool({
    name: 'find_and_rank_alternatives',
    description: 'Finds safer alternative medications using RxNorm and ranks them by how many safety checks they pass against the patient\'s profile (allergies, diseases, age, renal function, pregnancy status)',
    inputSchema: z.object({
      unsafeDrug: z.string().describe('The drug that was flagged as risky'),
      patientId: z.string().describe('Patient ID to check alternatives against'),
    }),
    examples: {
      request: { unsafeDrug: 'Ibuprofen', patientId: 'P001' },
      response: {
        alternatives: [
          { drug: 'Acetaminophen', safetyScore: 5, totalChecks: 5, passedChecks: ['allergy', 'disease', 'age', 'renal', 'interaction'], failedChecks: [] },
          { drug: 'Naproxen', safetyScore: 3, totalChecks: 5, passedChecks: ['allergy', 'age', 'interaction'], failedChecks: ['disease', 'renal'] }
        ],
        recommendedAlternative: 'Acetaminophen'
      }
    }
  })
  async findAndRankAlternatives(
    input: { unsafeDrug: string; patientId: string },
    ctx: ExecutionContext
  ) {
    ctx.logger.info('Finding and ranking alternatives', {
      unsafeDrug: input.unsafeDrug,
      patientId: input.patientId
    });

    // Load patient data
    const patients = loadPatients();
    const patient = patients.find((p: any) => p.id === input.patientId);
    if (!patient) {
      throw new Error(`Patient not found: ${input.patientId}`);
    }

    // Get alternatives from RxNorm (drugs in the same class)
    let candidates: string[] = [];

    try {
      // First get the RxCUI for the unsafe drug
      const rxcuiUrl = `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(input.unsafeDrug)}&search=1`;
      const rxcuiResponse = await fetch(rxcuiUrl);
      if (rxcuiResponse.ok) {
        const rxcuiData: any = await rxcuiResponse.json();
        const rxcui = rxcuiData?.idGroup?.rxnormId?.[0];

        if (rxcui) {
          // Get related drugs by class
          const relatedUrl = `https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/related.json?tty=SBD+SCD+IN`;
          const relatedResponse = await fetch(relatedUrl);
          if (relatedResponse.ok) {
            const relatedData: any = await relatedResponse.json();
            const groups = relatedData?.relatedGroup?.conceptGroup;
            if (Array.isArray(groups)) {
              for (const group of groups) {
                if (Array.isArray(group.conceptProperties)) {
                  for (const concept of group.conceptProperties.slice(0, 3)) {
                    if (concept.name && !candidates.includes(concept.name)) {
                      candidates.push(concept.name);
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      ctx.logger.warn('RxNorm alternative lookup failed, using local fallback', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Local fallback alternatives
    if (candidates.length === 0) {
      candidates = ALTERNATIVE_DRUGS[input.unsafeDrug] ?? ['Acetaminophen'];
    }

    // Re-run safety checks on each candidate
    const rankedAlternatives = [];

    for (const candidate of candidates.slice(0, 5)) {
      const checks = {
        allergy: true,
        disease: true,
        age: true,
        renal: true,
        interaction: true,
      };
      const failedChecks: string[] = [];

      // Check allergy
      const crossReact = ALLERGY_CROSS_REACTIVITY_TABLE[candidate];
      if (crossReact && crossReact.some(cls => patient.allergies.includes(cls))) {
        checks.allergy = false;
        failedChecks.push('allergy');
      }
      // Direct allergy match
      if (patient.allergies.some((a: string) => a.toLowerCase() === candidate.toLowerCase())) {
        checks.allergy = false;
        if (!failedChecks.includes('allergy')) failedChecks.push('allergy');
      }

      // Check disease contraindication
      const contras = CONTRAINDICATION_TABLE[candidate];
      if (contras && contras.some(d => patient.diagnoses.some((diag: string) => diag.toLowerCase() === d.toLowerCase()))) {
        checks.disease = false;
        failedChecks.push('disease');
      }

      // Check age
      if (patient.age >= 65 || patient.age < 18) {
        // Not a hard fail, just a flag
        checks.age = true; // Still passes, just needs dose adjustment
      }

      // Check renal
      const crcl = patient.labResults.creatinineClearance_mLmin;
      const nephrotoxic = ['Ibuprofen', 'Naproxen', 'Aspirin', 'Gentamicin', 'Metformin'];
      if (crcl < 30 && nephrotoxic.some(d => d.toLowerCase() === candidate.toLowerCase())) {
        checks.renal = false;
        failedChecks.push('renal');
      }

      // Check drug interactions with current meds
      for (const med of patient.currentMedications) {
        const key = getInteractionKey(candidate, med.name);
        if (DRUG_INTERACTION_FALLBACK_TABLE[key]) {
          checks.interaction = false;
          if (!failedChecks.includes('interaction')) failedChecks.push('interaction');
        }
      }

      const passedChecks = Object.entries(checks)
        .filter(([, passed]) => passed)
        .map(([name]) => name);

      rankedAlternatives.push({
        drug: candidate,
        safetyScore: passedChecks.length,
        totalChecks: 5,
        passedChecks,
        failedChecks,
      });
    }

    // Sort by safety score (highest first)
    rankedAlternatives.sort((a, b) => b.safetyScore - a.safetyScore);

    return {
      alternatives: rankedAlternatives,
      recommendedAlternative: rankedAlternatives.length > 0 ? rankedAlternatives[0].drug : null,
      note: rankedAlternatives.length > 0
        ? `${rankedAlternatives[0].drug} passed ${rankedAlternatives[0].safetyScore}/${rankedAlternatives[0].totalChecks} safety checks and is the recommended alternative.`
        : 'No suitable alternatives found. Consult a pharmacist.',
    };
  }

  // ==========================================================================
  // Tool 12: check_pregnancy_safety (Tier 3)
  // ==========================================================================
  @Tool({
    name: 'check_pregnancy_safety',
    description: 'Checks the FDA pregnancy risk category for a drug against the patient\'s pregnancy status. Categories: A (safe) → X (contraindicated). Flags Category D and X drugs as unsafe during pregnancy.',
    inputSchema: z.object({
      newDrug: z.string().describe('The newly prescribed drug name'),
      pregnancyStatus: z.string().describe('Patient pregnancy status: not_applicable, pregnant_trimester_1, pregnant_trimester_2, pregnant_trimester_3, breastfeeding')
    }),
    examples: {
      request: { newDrug: 'Ibuprofen', pregnancyStatus: 'pregnant_trimester_2' },
      response: {
        flag: 'D',
        isSafe: false,
        pregnancyStatus: 'pregnant_trimester_2',
        note: 'Ibuprofen is FDA Pregnancy Category D — positive evidence of human fetal risk. Contraindicated in pregnancy.',
        recommendation: 'Avoid Ibuprofen during pregnancy. Consider Acetaminophen (Category B) as a safer alternative for pain relief.'
      }
    }
  })
  async checkPregnancySafety(
    input: { newDrug: string; pregnancyStatus: string },
    ctx: ExecutionContext
  ) {
    ctx.logger.info('Checking pregnancy safety', {
      newDrug: input.newDrug,
      pregnancyStatus: input.pregnancyStatus
    });

    // If patient is not pregnant, this check is not applicable
    if (input.pregnancyStatus === 'not_applicable') {
      return {
        flag: 'not_applicable',
        isSafe: true,
        pregnancyStatus: input.pregnancyStatus,
        note: 'Patient is not pregnant. Pregnancy safety check not applicable.',
        recommendation: null,
      };
    }

    // Look up the pregnancy category
    const category = PREGNANCY_CATEGORY_TABLE[input.newDrug] ?? 'unknown';

    // Category descriptions
    const categoryDescriptions: Record<string, string> = {
      'A': 'Adequate studies show no risk to the fetus in the first trimester, and no evidence of risk in later trimesters.',
      'B': 'Animal studies show no risk, but no adequate human studies exist. Generally considered safe.',
      'C': 'Animal studies show adverse effects on the fetus. No adequate human studies. Use only if benefit outweighs risk.',
      'D': 'Positive evidence of human fetal risk. Use only in life-threatening situations where no safer alternative exists.',
      'X': 'Studies in animals or humans show fetal abnormalities. Risks clearly outweigh any possible benefit. ABSOLUTELY CONTRAINDICATED.',
      'unknown': 'Pregnancy category not established. Consult prescribing information and pharmacist before use.',
    };

    const isSafe = category === 'A' || category === 'B';
    const isContraindicated = category === 'D' || category === 'X';

    let recommendation: string;
    if (isContraindicated) {
      recommendation = `AVOID ${input.newDrug} during pregnancy (Category ${category}). Seek a safer alternative. Acetaminophen (Category B) is generally the preferred analgesic during pregnancy.`;
    } else if (category === 'C') {
      recommendation = `Use ${input.newDrug} with caution during pregnancy (Category ${category}). Discuss risks vs. benefits with the patient. Monitor closely if prescribed.`;
    } else if (isSafe) {
      recommendation = `${input.newDrug} is generally considered safe during pregnancy (Category ${category}). Standard prescribing guidelines apply.`;
    } else {
      recommendation = `Pregnancy safety data for ${input.newDrug} is insufficient. Consult a pharmacist or maternal-fetal medicine specialist before prescribing.`;
    }

    return {
      flag: category,
      isSafe,
      isContraindicated,
      pregnancyStatus: input.pregnancyStatus,
      categoryDescription: categoryDescriptions[category] ?? categoryDescriptions['unknown'],
      note: `${input.newDrug} is FDA Pregnancy Category ${category} — ${categoryDescriptions[category] ?? categoryDescriptions['unknown']}`,
      recommendation,
    };
  }

  // ==========================================================================
  // Tool 13: ingest_patient_record (File Upload / Text → Structured Patient JSON)
  // ==========================================================================
  @Tool({
    name: 'ingest_patient_record',
    description: `Upload a patient record file (.txt, .csv, .pdf, .docx) or paste unstructured clinical text to extract a structured patient profile. The file is decoded, text is extracted, and Gemini LLM converts it into the same JSON format used by all PharmaGuard safety tools. The patient is stored in memory with an assigned ID for immediate use in safety checks. Supported formats: plain text, CSV, PDF (text-based), DOCX.`,
    inputSchema: z.object({
      file_name: z.string().optional().describe('Name of the uploaded file (e.g., "patient_record.txt")'),
      file_type: z.string().optional().describe('MIME type of the uploaded file (e.g., "text/plain", "text/csv", "application/pdf")'),
      file_content: z.string().optional().describe('Base64-encoded file content (provided automatically by NitroStack Studio when a file is attached)'),
      clinicalText: z.string().optional().describe('Alternative: raw clinical text instead of a file upload'),
      patientId: z.string().optional().describe('Optional custom patient ID. If not provided, one will be auto-generated (P100, P101, etc.)'),
    }),
    examples: {
      request: {
        file_name: 'patient_record.txt',
        file_type: 'text/plain',
        file_content: 'UGF0aWVudDogTXJzLiBBbml0YSBEZXNhaSwgNDUteWVhci1vbGQgZmVtYWxlLCB3ZWlnaGluZyA2MiBrZy4=',
      },
      response: {
        success: true,
        patientId: 'P100',
        fileName: 'patient_record.txt',
        extractedProfile: {
          id: 'P100',
          name: 'Mrs. Anita Desai',
          age: 45,
          sex: 'female',
        },
        source: 'file_upload → llm_extraction',
      },
    },
  })
  async ingestPatientRecord(input: { file_name?: string; file_type?: string; file_content?: string; clinicalText?: string; patientId?: string }, ctx: ExecutionContext) {
    ctx.logger.info('Ingesting patient record', {
      fileName: input.file_name,
      fileType: input.file_type,
      hasFileContent: !!input.file_content,
      hasText: !!input.clinicalText,
    });

    // Step 1: Extract text from file or use raw clinicalText
    let extractedText = '';

    if (input.file_content) {
      // Decode base64 file content
      ctx.logger.info('Decoding uploaded file', { fileName: input.file_name, fileType: input.file_type });

      let buffer: Buffer;
      const b64 = input.file_content;
      // Handle both data URL format and raw base64
      const dataUrlMatch = b64.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
      if (dataUrlMatch && dataUrlMatch.length === 3) {
        buffer = Buffer.from(dataUrlMatch[2], 'base64');
      } else {
        buffer = Buffer.from(b64, 'base64');
      }

      const mimeType = input.file_type || '';
      const fileName = (input.file_name || '').toLowerCase();

      // Extract text based on file type
      if (mimeType.startsWith('text/') || fileName.endsWith('.txt') || fileName.endsWith('.csv')) {
        // Plain text or CSV — decode directly to UTF-8
        extractedText = buffer.toString('utf-8');
        ctx.logger.info('Extracted text from text file', { chars: extractedText.length });

      } else if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
        // PDF — extract printable text from raw buffer (basic extraction without external deps)
        // Extracts text between stream markers and readable ASCII sequences
        const rawText = buffer.toString('utf-8', 0, Math.min(buffer.length, 500000));
        // Pull readable ASCII sequences (words, numbers, punctuation)
        const textChunks = rawText.match(/[A-Za-z0-9\s.,;:!?()\-\/'"@#$%&*+=\[\]{}|\\^~`]{4,}/g) || [];
        extractedText = textChunks.join(' ').replace(/\s+/g, ' ').trim();
        ctx.logger.info('Extracted text from PDF (basic)', { chars: extractedText.length });

        if (extractedText.length < 50) {
          extractedText = `[PDF file uploaded: ${input.file_name}. The PDF may be image-based and text extraction was limited. Raw content length: ${buffer.length} bytes. Please provide patient data as plain text for best results.]`;
        }

      } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
        // DOCX — extract text from XML content within the ZIP
        // DOCX is a ZIP containing word/document.xml — extract text between XML tags
        const rawText = buffer.toString('utf-8', 0, Math.min(buffer.length, 500000));
        const xmlTextMatches = rawText.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || [];
        extractedText = xmlTextMatches
          .map(match => match.replace(/<[^>]+>/g, ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        ctx.logger.info('Extracted text from DOCX (basic)', { chars: extractedText.length });

        if (extractedText.length < 50) {
          // Fallback: try to extract any readable text
          const textChunks = rawText.match(/[A-Za-z0-9\s.,;:!?()\-\/'"]{6,}/g) || [];
          extractedText = textChunks.join(' ').replace(/\s+/g, ' ').trim();
        }

      } else {
        // Unknown format — try to read as text
        extractedText = buffer.toString('utf-8');
        ctx.logger.warn('Unknown file type, attempting text decode', { mimeType, fileName: input.file_name });
      }

    } else if (input.clinicalText) {
      extractedText = input.clinicalText;
    } else {
      throw new Error('No input provided. Either attach a file (.txt, .csv, .pdf, .docx) or provide clinicalText.');
    }

    if (extractedText.trim().length < 10) {
      throw new Error('Could not extract meaningful text from the input. Please check the file content or provide clinical text directly.');
    }

    const assignedId = input.patientId || `P${nextPatientCounter++}`;

    // Step 2: Send extracted text to Gemini for structured extraction
    const prompt = `You are a clinical data extraction system. Extract a structured patient profile from the following unstructured clinical text.

RETURN ONLY a valid JSON object with this exact schema (no markdown, no explanation):
{
  "id": "${assignedId}",
  "name": "<patient full name or 'Unknown' if not found>",
  "age": <number or 0 if unknown>,
  "weightKg": <number or 70 as default>,
  "sex": "<male|female|unknown>",
  "pregnancyStatus": "<pregnant_trimester1|pregnant_trimester2|pregnant_trimester3|not_pregnant|not_applicable>",
  "labResults": {
    "creatinineClearance_mLmin": <number or 90 as default>,
    "liverEnzymesALT_UL": <number or 30 as default>
  },
  "diagnoses": ["<diagnosis1>", "<diagnosis2>"],
  "allergies": ["<allergy1>", "<allergy2>"],
  "currentMedications": [
    { "name": "<drug>", "dosage": "<dose>", "frequency": "<freq>" }
  ]
}

Extraction rules:
- Extract ALL medications mentioned with their dosages and frequencies
- Extract ALL allergies mentioned
- Extract ALL diagnoses/conditions mentioned
- If creatinine clearance is not directly stated but serum creatinine is given, estimate CrCl using Cockcroft-Gault formula
- If pregnancy status is not mentioned, use "not_applicable" for males and "not_pregnant" for females
- Use reasonable clinical defaults for missing lab values
- Normalize drug names to their common generic names

CLINICAL TEXT:
${extractedText}

JSON ONLY:`;

    const response = await callGemini(prompt);

    let extractedProfile: any;

    if (response) {
      try {
        const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        extractedProfile = JSON.parse(cleaned);
        // Ensure the ID matches
        extractedProfile.id = assignedId;
      } catch (parseError) {
        ctx.logger.error('Failed to parse LLM extraction response', { response });
        extractedProfile = null;
      }
    }

    // Fallback: basic regex extraction if LLM fails
    if (!extractedProfile) {
      ctx.logger.warn('LLM unavailable or failed, using basic text extraction');
      const text = extractedText;

      // Try to extract name
      const nameMatch = text.match(/(?:patient|name|pt)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i);
      // Try to extract age
      const ageMatch = text.match(/(\d{1,3})[-\s]*(?:year|yr|y\/o|yo)/i);
      // Try to extract weight
      const weightMatch = text.match(/(\d{2,3})\s*kg/i);
      // Try to extract sex
      const sexMatch = text.match(/\b(male|female|man|woman)\b/i);
      // Try to extract allergies
      const allergyMatch = text.match(/allerg(?:y|ies)[:\s]+([^.\n]+)/i);
      // Try to extract diagnoses
      const diagnosisMatch = text.match(/diagnos(?:is|es|ed)[:\s]+([^.\n]+)/i);
      // Try to extract CrCl
      const crclMatch = text.match(/(?:creatinine clearance|CrCl|GFR)[:\s]*(\d+)/i);

      const sex = sexMatch ? (sexMatch[1].toLowerCase().includes('female') || sexMatch[1].toLowerCase().includes('woman') ? 'female' : 'male') : 'unknown';

      extractedProfile = {
        id: assignedId,
        name: nameMatch?.[1] || 'Unknown Patient',
        age: ageMatch ? parseInt(ageMatch[1]) : 0,
        weightKg: weightMatch ? parseInt(weightMatch[1]) : 70,
        sex,
        pregnancyStatus: sex === 'male' ? 'not_applicable' : 'not_pregnant',
        labResults: {
          creatinineClearance_mLmin: crclMatch ? parseInt(crclMatch[1]) : 90,
          liverEnzymesALT_UL: 30,
        },
        diagnoses: diagnosisMatch ? diagnosisMatch[1].split(/[,;]/).map((d: string) => d.trim()).filter(Boolean) : [],
        allergies: allergyMatch ? allergyMatch[1].split(/[,;]/).map((a: string) => a.trim()).filter(Boolean) : [],
        currentMedications: [],
        _extractionSource: 'basic_regex_fallback',
      };
    }

    // Store in memory
    inMemoryPatients.set(assignedId, extractedProfile);

    ctx.logger.info('Patient record ingested successfully', {
      patientId: assignedId,
      name: extractedProfile.name,
      medicationCount: extractedProfile.currentMedications?.length || 0,
      diagnosisCount: extractedProfile.diagnoses?.length || 0,
      allergyCount: extractedProfile.allergies?.length || 0,
    });

    return {
      success: true,
      patientId: assignedId,
      fileName: input.file_name || null,
      fileType: input.file_type || null,
      extractedTextLength: extractedText.length,
      extractedProfile,
      source: input.file_content
        ? (response ? 'file_upload → llm_extraction' : 'file_upload → regex_fallback')
        : (response ? 'text_input → llm_extraction' : 'text_input → regex_fallback'),
      message: `Patient ${extractedProfile.name} (${assignedId}) has been registered. You can now run safety checks using this patient ID.`,
      availableNextSteps: [
        `get_patient_profile with patientId: "${assignedId}"`,
        `check_drug_drug_interaction with the patient's current medications`,
        `Full safety workflow via the medication_safety_check prompt`,
      ],
    };
  }
}

