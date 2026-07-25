/**
 * 🛡️ Safety Agent
 * Responsible for all drug safety checks: drug interactions, allergies,
 * disease contraindications, age appropriateness, renal adjustment,
 * pregnancy safety, and duplicate therapy detection.
 * 
 * Tools: check_drug_drug_interaction, check_drug_allergy_conflict,
 *        check_disease_conflict, check_age_appropriateness,
 *        check_renal_dose_adjustment, check_pregnancy_safety,
 *        check_duplicate_therapy, extract_clinical_entities,
 *        find_and_rank_alternatives
 */
import { ToolDecorator as Tool, ExecutionContext, z } from '@nitrostack/core';
import { loadPatients, callGemini } from '../shared-utils.js';
import {
  ALLERGY_CROSS_REACTIVITY_TABLE,
  CONTRAINDICATION_TABLE,
  DRUG_INTERACTION_FALLBACK_TABLE,
  PREGNANCY_CATEGORY_TABLE,
  LOCAL_DRUG_CLASSES,
  ALTERNATIVE_DRUGS,
  getInteractionKey,
} from '../data/clinical-tables.js';

export class SafetyAgent {

  // ==========================================================================
  // extract_clinical_entities
  // ==========================================================================
  @Tool({
    name: 'extract_clinical_entities',
    description: 'Uses LLM to parse a doctor\'s natural language prescription note into structured clinical entities (drug name, dosage, frequency, reason)',
    inputSchema: z.object({
      prescriptionNote: z.string().describe('The doctor\'s free-text prescription note, e.g. "Prescribe Ibuprofen 400mg three times daily for headache"')
    }),
    examples: {
      request: { prescriptionNote: 'Prescribe Ibuprofen 400mg three times daily for headache' },
      response: { drugName: 'Ibuprofen', dosage: '400mg', frequency: 'three times daily', reason: 'headache' }
    }
  })
  async extractClinicalEntities(input: { prescriptionNote: string }, ctx: ExecutionContext) {
    ctx.logger.info('Extracting clinical entities from prescription note', { note: input.prescriptionNote });

    const prompt = `You are a clinical NLP system. Extract the following fields from the doctor's prescription note.
Return ONLY a valid JSON object with these fields:
- drugName (string): the medication being prescribed
- dosage (string): the dose amount (e.g. "400mg")
- frequency (string): how often to take it (e.g. "three times daily")
- reason (string): the medical reason for the prescription

Prescription note: "${input.prescriptionNote}"

Respond with ONLY the JSON object, no markdown, no explanation.`;

    const response = await callGemini(prompt);

    if (!response) {
      ctx.logger.warn('Gemini unavailable, using basic extraction');
      const note = input.prescriptionNote;
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
      return { drugName: 'Unknown', dosage: 'Not specified', frequency: 'Not specified', reason: 'Not specified', rawResponse: response, parseError: 'Failed to parse LLM output as JSON' };
    }
  }

  // ==========================================================================
  // check_drug_drug_interaction
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
        interactions: [{ drug1: 'Ibuprofen', drug2: 'Lisinopril', severity: 'major', description: 'NSAIDs reduce the antihypertensive effect of ACE inhibitors' }]
      }
    }
  })
  async checkDrugDrugInteraction(input: { newDrug: string; currentMedications: string[] }, ctx: ExecutionContext) {
    ctx.logger.info('Checking drug-drug interactions', { newDrug: input.newDrug, against: input.currentMedications });

    const interactions: Array<{ drug1: string; drug2: string; severity: string; description: string; source: string }> = [];

    for (const currentMed of input.currentMedications) {
      let foundViaApi = false;
      try {
        const searchTerm = `"${input.newDrug}" AND "${currentMed}"`;
        const url = `https://api.fda.gov/drug/label.json?search=drug_interactions:${encodeURIComponent(searchTerm)}&limit=1`;
        const response = await fetch(url);
        if (response.ok) {
          const data: any = await response.json();
          if (data.results && data.results.length > 0) {
            const interactionText = data.results[0].drug_interactions?.[0] || 'Interaction found in FDA label data.';
            interactions.push({ drug1: input.newDrug, drug2: currentMed, severity: 'major', description: interactionText.substring(0, 300), source: 'OpenFDA' });
            foundViaApi = true;
          }
        }
      } catch (error) {
        ctx.logger.warn('OpenFDA API call failed, falling back to local table');
      }

      if (!foundViaApi) {
        const key = getInteractionKey(input.newDrug, currentMed);
        const fallback = DRUG_INTERACTION_FALLBACK_TABLE[key];
        if (fallback) {
          interactions.push({ drug1: input.newDrug, drug2: currentMed, severity: fallback.severity, description: fallback.description, source: 'Local Clinical Database' });
        }
      }
    }

    return {
      hasInteraction: interactions.length > 0,
      interactions,
      checkedPairs: input.currentMedications.map(med => `${input.newDrug} ↔ ${med}`),
      citation: interactions.length > 0
        ? interactions.map(i => `${i.drug1} ↔ ${i.drug2}: Source — ${i.source === 'OpenFDA' ? 'U.S. FDA Drug Label Database (openFDA)' : 'PharmaGuard Local Clinical Interaction Database'}`).join('; ')
        : 'No interaction found in OpenFDA or local database.',
    };
  }

  // ==========================================================================
  // check_drug_allergy_conflict
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
      response: { hasConflict: true, detail: 'Amoxicillin may cross-react with documented allergy: Penicillin' }
    }
  })
  async checkDrugAllergyConflict(input: { newDrug: string; allergies: string[] }, ctx: ExecutionContext) {
    ctx.logger.info('Checking allergy conflicts', { newDrug: input.newDrug, allergies: input.allergies });

    if (input.allergies.length === 0) return { hasConflict: false, detail: null };

    const crossReactivities = ALLERGY_CROSS_REACTIVITY_TABLE[input.newDrug];

    if (!crossReactivities) {
      const directMatch = input.allergies.find(a => a.toLowerCase() === input.newDrug.toLowerCase());
      if (directMatch) return { hasConflict: true, detail: `${input.newDrug} is directly listed as a patient allergy`, citation: 'Direct match in patient allergy records (EHR)' };
      return { hasConflict: false, detail: null };
    }

    const matchedAllergy = crossReactivities.find(cls => input.allergies.some(a => a.toLowerCase() === cls.toLowerCase()));
    if (matchedAllergy) {
      return { hasConflict: true, detail: `${input.newDrug} may cross-react with documented allergy: ${matchedAllergy}`, citation: 'Cross-Reactivity Reference: Drug Allergy Cross-Sensitivity Database (Immunology & Allergy Clinics of North America)' };
    }

    return { hasConflict: false, detail: null };
  }

  // ==========================================================================
  // check_disease_conflict
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
      response: { hasConflict: true, conflictingDiagnosis: 'CKD Stage 3', detail: 'Ibuprofen is contraindicated in patients with CKD Stage 3' }
    }
  })
  async checkDiseaseConflict(input: { newDrug: string; diagnoses: string[] }, ctx: ExecutionContext) {
    ctx.logger.info('Checking disease conflicts', { newDrug: input.newDrug, diagnoses: input.diagnoses });

    const contraindications = CONTRAINDICATION_TABLE[input.newDrug];
    if (!contraindications) return { hasConflict: false, conflictingDiagnosis: null, detail: null };

    const conflict = contraindications.find(d => input.diagnoses.some(diag => diag.toLowerCase() === d.toLowerCase()));
    if (conflict) {
      return { hasConflict: true, conflictingDiagnosis: conflict, detail: `${input.newDrug} is contraindicated in patients with ${conflict}`, citation: 'Contraindication Reference: FDA Drug Label; Clinical Pharmacology & Therapeutics Guidelines' };
    }

    return { hasConflict: false, conflictingDiagnosis: null, detail: null };
  }

  // ==========================================================================
  // check_age_appropriateness
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
      response: { flag: 'elderly', note: 'Consider reduced starting dose per Beers Criteria.' }
    }
  })
  async checkAgeAppropriateness(input: { newDrug: string; age: number }, ctx: ExecutionContext) {
    ctx.logger.info('Checking age appropriateness', { newDrug: input.newDrug, age: input.age });

    if (input.age >= 65) {
      return { flag: 'elderly', note: `Patient is ${input.age} years old. Consider reduced starting dose per Beers Criteria. Review ${input.newDrug} for age-related dose adjustments.`, citation: 'AGS Beers Criteria® for Potentially Inappropriate Medication Use in Older Adults (American Geriatrics Society, 2023 Update)' };
    }
    if (input.age < 18) {
      return { flag: 'pediatric', note: `Patient is ${input.age} years old. Verify pediatric dosing guidelines for ${input.newDrug}. Weight-based dosing may be required.`, citation: 'Pediatric Dosing Guidelines: Harriet Lane Handbook (Johns Hopkins); BNF for Children (BNFC)' };
    }
    return { flag: 'none', note: null };
  }

  // ==========================================================================
  // check_renal_dose_adjustment
  // ==========================================================================
  @Tool({
    name: 'check_renal_dose_adjustment',
    description: 'Flags if the drug dose needs adjustment based on kidney function (creatinine clearance). Uses CKD staging thresholds.',
    inputSchema: z.object({
      newDrug: z.string().describe('The newly prescribed drug name'),
      creatinineClearance: z.number().describe('Patient creatinine clearance in mL/min')
    }),
    examples: {
      request: { newDrug: 'Ibuprofen', creatinineClearance: 22 },
      response: { flag: 'severe_renal_impairment', stage: 'CKD Stage 4', recommendation: 'Avoid NSAIDs in severe renal impairment.' }
    }
  })
  async checkRenalDoseAdjustment(input: { newDrug: string; creatinineClearance: number }, ctx: ExecutionContext) {
    ctx.logger.info('Checking renal dose adjustment', { newDrug: input.newDrug, creatinineClearance: input.creatinineClearance });
    const crcl = input.creatinineClearance;

    let stage: string, flag: string, recommendation: string;

    if (crcl < 15) { stage = 'CKD Stage 5 (Kidney Failure)'; flag = 'kidney_failure'; recommendation = `${input.newDrug} is likely contraindicated. Consult nephrology.`; }
    else if (crcl < 30) { stage = 'CKD Stage 4 (Severe Impairment)'; flag = 'severe_renal_impairment'; recommendation = `${input.newDrug} may need significant dose reduction or avoidance. CrCl ${crcl} mL/min.`; }
    else if (crcl < 60) { stage = 'CKD Stage 3 (Moderate Impairment)'; flag = 'moderate_renal_impairment'; recommendation = `Consider dose adjustment for ${input.newDrug}. CrCl ${crcl} mL/min. Monitor renal function.`; }
    else if (crcl < 90) { stage = 'CKD Stage 2 (Mild Impairment)'; flag = 'mild_renal_impairment'; recommendation = `Standard dosing likely appropriate for ${input.newDrug}, but monitor renal function.`; }
    else { stage = 'Normal Kidney Function'; flag = 'normal'; recommendation = `No renal dose adjustment needed for ${input.newDrug}.`; }

    const nephrotoxicDrugs = ['Ibuprofen', 'Naproxen', 'Aspirin', 'Gentamicin', 'Vancomycin', 'Metformin'];
    const isNephrotoxic = nephrotoxicDrugs.some(d => d.toLowerCase() === input.newDrug.toLowerCase());
    if (isNephrotoxic && crcl < 60) recommendation += ` ⚠️ ${input.newDrug} is known to be nephrotoxic.`;

    return { flag, stage, creatinineClearance: crcl, note: `CrCl ${crcl} mL/min → ${stage}`, recommendation, isNephrotoxic, citation: 'CKD Staging per KDIGO (Kidney Disease: Improving Global Outcomes) Clinical Practice Guidelines, 2024' };
  }

  // ==========================================================================
  // check_pregnancy_safety
  // ==========================================================================
  @Tool({
    name: 'check_pregnancy_safety',
    description: 'Checks the FDA pregnancy risk category for a drug. Categories: A (safe) → X (contraindicated).',
    inputSchema: z.object({
      newDrug: z.string().describe('The newly prescribed drug name'),
      pregnancyStatus: z.string().describe('Patient pregnancy status: not_applicable, pregnant_trimester_1/2/3, breastfeeding')
    }),
    examples: {
      request: { newDrug: 'Ibuprofen', pregnancyStatus: 'pregnant_trimester_2' },
      response: { flag: 'D', isSafe: false, note: 'Ibuprofen is FDA Pregnancy Category D — contraindicated in pregnancy.' }
    }
  })
  async checkPregnancySafety(input: { newDrug: string; pregnancyStatus: string }, ctx: ExecutionContext) {
    ctx.logger.info('Checking pregnancy safety', { newDrug: input.newDrug, pregnancyStatus: input.pregnancyStatus });

    if (input.pregnancyStatus === 'not_applicable') {
      return { flag: 'not_applicable', isSafe: true, pregnancyStatus: input.pregnancyStatus, note: 'Patient is not pregnant.', recommendation: null };
    }

    const category = PREGNANCY_CATEGORY_TABLE[input.newDrug] ?? 'unknown';
    const categoryDescriptions: Record<string, string> = {
      'A': 'No risk shown in adequate studies.', 'B': 'Animal studies show no risk; no adequate human studies.', 'C': 'Animal studies show adverse effects. Use only if benefit outweighs risk.',
      'D': 'Positive evidence of human fetal risk. Use only in life-threatening situations.', 'X': 'ABSOLUTELY CONTRAINDICATED. Risks clearly outweigh any possible benefit.', 'unknown': 'Category not established. Consult pharmacist.',
    };

    const isSafe = category === 'A' || category === 'B';
    const isContraindicated = category === 'D' || category === 'X';

    let recommendation: string;
    if (isContraindicated) recommendation = `AVOID ${input.newDrug} during pregnancy (Category ${category}). Consider Acetaminophen (Category B).`;
    else if (category === 'C') recommendation = `Use ${input.newDrug} with caution during pregnancy (Category ${category}).`;
    else if (isSafe) recommendation = `${input.newDrug} is generally safe during pregnancy (Category ${category}).`;
    else recommendation = `Pregnancy safety data for ${input.newDrug} is insufficient. Consult pharmacist.`;

    return { flag: category, isSafe, isContraindicated, pregnancyStatus: input.pregnancyStatus, categoryDescription: categoryDescriptions[category] ?? categoryDescriptions['unknown'], note: `${input.newDrug} is FDA Pregnancy Category ${category} — ${categoryDescriptions[category] ?? categoryDescriptions['unknown']}`, recommendation, citation: 'FDA Pregnancy Risk Category System; Drugs in Pregnancy and Lactation (Briggs, Freeman & Yaffe, 12th Edition)' };
  }

  // ==========================================================================
  // check_duplicate_therapy
  // ==========================================================================
  @Tool({
    name: 'check_duplicate_therapy',
    description: 'Checks if the new drug is in the same therapeutic class as any existing medication using RxNorm API.',
    inputSchema: z.object({
      newDrug: z.string().describe('The newly prescribed drug name'),
      currentMedications: z.array(z.string()).describe('List of current medication names')
    }),
    examples: {
      request: { newDrug: 'Aspirin', currentMedications: ['Warfarin', 'Metoprolol'] },
      response: { hasDuplicate: true, duplicates: [{ newDrug: 'Aspirin', existingDrug: 'Warfarin', sharedClass: 'Anticoagulants / Antithrombotics' }] }
    }
  })
  async checkDuplicateTherapy(input: { newDrug: string; currentMedications: string[] }, ctx: ExecutionContext) {
    ctx.logger.info('Checking duplicate therapy via RxNorm', { newDrug: input.newDrug, currentMedications: input.currentMedications });

    const duplicates: Array<{ newDrug: string; existingDrug: string; sharedClass: string; detail: string }> = [];
    let newDrugClasses: string[] = [];

    try {
      const classUrl = `https://rxnav.nlm.nih.gov/REST/rxclass/class/byDrugName.json?drugName=${encodeURIComponent(input.newDrug)}&relaSource=ATC`;
      const classResponse = await fetch(classUrl);
      if (classResponse.ok) {
        const classData: any = await classResponse.json();
        const entries = classData?.rxclassDrugInfoList?.rxclassDrugInfo;
        if (Array.isArray(entries)) newDrugClasses = entries.map((e: any) => e.rxclassMinConceptItem?.className).filter(Boolean);
      }
    } catch (error) { ctx.logger.warn('RxNorm API failed for new drug class lookup'); }

    if (newDrugClasses.length === 0) newDrugClasses = LOCAL_DRUG_CLASSES[input.newDrug] ?? [];

    for (const currentMed of input.currentMedications) {
      let currentMedClasses: string[] = [];
      try {
        const medClassUrl = `https://rxnav.nlm.nih.gov/REST/rxclass/class/byDrugName.json?drugName=${encodeURIComponent(currentMed)}&relaSource=ATC`;
        const medResponse = await fetch(medClassUrl);
        if (medResponse.ok) {
          const medData: any = await medResponse.json();
          const entries = medData?.rxclassDrugInfoList?.rxclassDrugInfo;
          if (Array.isArray(entries)) currentMedClasses = entries.map((e: any) => e.rxclassMinConceptItem?.className).filter(Boolean);
        }
      } catch (error) { ctx.logger.warn('RxNorm API failed for current med class lookup'); }

      if (currentMedClasses.length === 0) currentMedClasses = LOCAL_DRUG_CLASSES[currentMed] ?? [];

      const shared = newDrugClasses.filter(cls => currentMedClasses.includes(cls));
      if (shared.length > 0) {
        duplicates.push({ newDrug: input.newDrug, existingDrug: currentMed, sharedClass: shared.join(', '), detail: `Both ${input.newDrug} and ${currentMed} belong to ${shared[0]}. Concurrent use may be redundant.` });
      }
    }

    return { hasDuplicate: duplicates.length > 0, duplicates, classesFound: { [input.newDrug]: newDrugClasses.slice(0, 5) }, citation: duplicates.length > 0 ? 'NIH RxNorm Drug Classification API + PharmaGuard Local Drug Class Database' : 'No duplicate therapy found.' };
  }

  // ==========================================================================
  // find_and_rank_alternatives
  // ==========================================================================
  @Tool({
    name: 'find_and_rank_alternatives',
    description: 'Finds safer alternative medications using RxNorm and ranks them by how many safety checks they pass against the patient\'s profile',
    inputSchema: z.object({
      unsafeDrug: z.string().describe('The drug that was flagged as risky'),
      patientId: z.string().describe('Patient ID to check alternatives against'),
    }),
    examples: {
      request: { unsafeDrug: 'Ibuprofen', patientId: 'P001' },
      response: { alternatives: [{ drug: 'Acetaminophen', safetyScore: 5 }], recommendedAlternative: 'Acetaminophen' }
    }
  })
  async findAndRankAlternatives(input: { unsafeDrug: string; patientId: string }, ctx: ExecutionContext) {
    ctx.logger.info('Finding and ranking alternatives', { unsafeDrug: input.unsafeDrug, patientId: input.patientId });

    const patients = loadPatients();
    const patient = patients.find((p: any) => p.id === input.patientId);
    if (!patient) throw new Error(`Patient not found: ${input.patientId}`);

    let candidates: string[] = [];
    try {
      const rxcuiUrl = `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(input.unsafeDrug)}&search=1`;
      const rxcuiResponse = await fetch(rxcuiUrl);
      if (rxcuiResponse.ok) {
        const rxcuiData: any = await rxcuiResponse.json();
        const rxcui = rxcuiData?.idGroup?.rxnormId?.[0];
        if (rxcui) {
          const relatedUrl = `https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/related.json?tty=SBD+SCD+IN`;
          const relatedResponse = await fetch(relatedUrl);
          if (relatedResponse.ok) {
            const relatedData: any = await relatedResponse.json();
            const groups = relatedData?.relatedGroup?.conceptGroup;
            if (Array.isArray(groups)) {
              for (const group of groups) {
                if (Array.isArray(group.conceptProperties)) {
                  for (const concept of group.conceptProperties.slice(0, 3)) {
                    if (concept.name && !candidates.includes(concept.name)) candidates.push(concept.name);
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) { ctx.logger.warn('RxNorm alternative lookup failed'); }

    if (candidates.length === 0) candidates = ALTERNATIVE_DRUGS[input.unsafeDrug] ?? ['Acetaminophen'];

    const rankedAlternatives = [];
    for (const candidate of candidates.slice(0, 5)) {
      const checks = { allergy: true, disease: true, age: true, renal: true, interaction: true };
      const failedChecks: string[] = [];

      const crossReact = ALLERGY_CROSS_REACTIVITY_TABLE[candidate];
      if (crossReact && crossReact.some(cls => patient.allergies.includes(cls))) { checks.allergy = false; failedChecks.push('allergy'); }
      if (patient.allergies.some((a: string) => a.toLowerCase() === candidate.toLowerCase())) { checks.allergy = false; if (!failedChecks.includes('allergy')) failedChecks.push('allergy'); }

      const contras = CONTRAINDICATION_TABLE[candidate];
      if (contras && contras.some(d => patient.diagnoses.some((diag: string) => diag.toLowerCase() === d.toLowerCase()))) { checks.disease = false; failedChecks.push('disease'); }

      const crcl = patient.labResults.creatinineClearance_mLmin;
      const nephrotoxic = ['Ibuprofen', 'Naproxen', 'Aspirin', 'Gentamicin', 'Metformin'];
      if (crcl < 30 && nephrotoxic.some(d => d.toLowerCase() === candidate.toLowerCase())) { checks.renal = false; failedChecks.push('renal'); }

      for (const med of patient.currentMedications) {
        const key = getInteractionKey(candidate, med.name);
        if (DRUG_INTERACTION_FALLBACK_TABLE[key]) { checks.interaction = false; if (!failedChecks.includes('interaction')) failedChecks.push('interaction'); }
      }

      const passedChecks = Object.entries(checks).filter(([, passed]) => passed).map(([name]) => name);
      rankedAlternatives.push({ drug: candidate, safetyScore: passedChecks.length, totalChecks: 5, passedChecks, failedChecks });
    }

    rankedAlternatives.sort((a, b) => b.safetyScore - a.safetyScore);
    return {
      alternatives: rankedAlternatives,
      recommendedAlternative: rankedAlternatives.length > 0 ? rankedAlternatives[0].drug : null,
      note: rankedAlternatives.length > 0 ? `${rankedAlternatives[0].drug} passed ${rankedAlternatives[0].safetyScore}/5 safety checks.` : 'No suitable alternatives found.',
    };
  }
}
