/**
 * Clinical Lookup Tables for PharmaGuard
 * 
 * These hardcoded tables provide rule-based safety checks without needing
 * external API calls. Each table is intentionally small (5-10 entries)
 * covering our 3 demo patients' scenarios.
 * 
 * In production, these would be replaced with a comprehensive drug database.
 */

// ============================================================================
// Allergy Cross-Reactivity Table
// Maps a drug to the allergy categories it cross-reacts with
// ============================================================================
export const ALLERGY_CROSS_REACTIVITY_TABLE: Record<string, string[]> = {
  // Penicillin family — all cross-react with "Penicillin" allergy
  'Amoxicillin': ['Penicillin'],
  'Ampicillin': ['Penicillin'],
  'Piperacillin': ['Penicillin'],
  'Penicillin V': ['Penicillin'],
  'Penicillin G': ['Penicillin'],
  // Cephalosporins — ~2% cross-reactivity with penicillin allergy
  'Cephalexin': ['Penicillin'],
  'Ceftriaxone': ['Penicillin'],
  // Sulfa drugs
  'Sulfamethoxazole': ['Sulfa'],
  'Sulfasalazine': ['Sulfa'],
  // NSAIDs — cross-react with aspirin sensitivity
  'Ibuprofen': ['Aspirin'],
  'Naproxen': ['Aspirin'],
};

// ============================================================================
// Disease Contraindication Table
// Maps a drug to diagnoses that contraindicate its use
// ============================================================================
export const CONTRAINDICATION_TABLE: Record<string, string[]> = {
  // NSAIDs contraindicated in CKD
  'Ibuprofen': ['CKD Stage 3', 'CKD Stage 4', 'CKD Stage 5', 'Peptic Ulcer', 'GI Bleeding'],
  'Naproxen': ['CKD Stage 3', 'CKD Stage 4', 'CKD Stage 5', 'Peptic Ulcer', 'GI Bleeding'],
  'Aspirin': ['CKD Stage 3', 'CKD Stage 4', 'CKD Stage 5', 'Peptic Ulcer', 'GI Bleeding'],
  // Beta-blockers contraindicated in Asthma
  'Propranolol': ['Asthma', 'COPD'],
  'Atenolol': ['Asthma'],
  // Metformin contraindicated in severe CKD
  'Metformin': ['CKD Stage 4', 'CKD Stage 5'],
  // ACE Inhibitors contraindicated in bilateral renal artery stenosis
  'Lisinopril': ['Bilateral Renal Artery Stenosis', 'Angioedema'],
  'Enalapril': ['Bilateral Renal Artery Stenosis', 'Angioedema'],
  // Warfarin — avoid with active bleeding
  'Warfarin': ['Active GI Bleeding', 'Hemorrhagic Stroke'],
};

// ============================================================================
// Drug-Drug Interaction Fallback Table
// Used when OpenFDA API is unavailable. Maps drug pairs to interaction info.
// Keys are sorted alphabetically: "DrugA|DrugB"
// ============================================================================
export const DRUG_INTERACTION_FALLBACK_TABLE: Record<string, { severity: string; description: string }> = {
  'Ibuprofen|Lisinopril': {
    severity: 'major',
    description: 'NSAIDs reduce the antihypertensive effect of ACE inhibitors and may increase the risk of renal impairment when used together.',
  },
  'Ibuprofen|Warfarin': {
    severity: 'major',
    description: 'NSAIDs increase the anticoagulant effect of Warfarin and significantly raise bleeding risk.',
  },
  'Aspirin|Warfarin': {
    severity: 'major',
    description: 'Aspirin increases bleeding risk when combined with Warfarin due to additive anticoagulant and antiplatelet effects.',
  },
  'Lisinopril|Potassium': {
    severity: 'moderate',
    description: 'ACE inhibitors can increase serum potassium levels; combined with potassium supplements, risk of hyperkalemia.',
  },
  'Metoprolol|Verapamil': {
    severity: 'major',
    description: 'Concurrent use of beta-blockers and calcium channel blockers may cause severe bradycardia and heart block.',
  },
  'Aspirin|Ibuprofen': {
    severity: 'moderate',
    description: 'Ibuprofen may interfere with the antiplatelet effect of low-dose aspirin.',
  },
  'Metformin|Lisinopril': {
    severity: 'minor',
    description: 'Generally safe combination; ACE inhibitors may slightly enhance the hypoglycemic effect of Metformin.',
  },
  'Sumatriptan|SSRI': {
    severity: 'moderate',
    description: 'Risk of serotonin syndrome when triptans are combined with SSRIs.',
  },
};

// ============================================================================
// Pregnancy Category Table
// FDA pregnancy risk categories: A (safest) → X (contraindicated)
// ============================================================================
export const PREGNANCY_CATEGORY_TABLE: Record<string, string> = {
  'Ibuprofen': 'D',       // Contraindicated in 3rd trimester, risky in 2nd
  'Aspirin': 'D',         // Contraindicated in pregnancy
  'Naproxen': 'D',        // Contraindicated in pregnancy
  'Lisinopril': 'X',      // Absolutely contraindicated in pregnancy
  'Enalapril': 'X',       // Absolutely contraindicated in pregnancy
  'Warfarin': 'X',        // Absolutely contraindicated in pregnancy
  'Metformin': 'B',       // Generally considered safe
  'Metoprolol': 'C',      // Use only if benefit outweighs risk
  'Sumatriptan': 'C',     // Limited data, use with caution
  'Amoxicillin': 'B',     // Generally considered safe
  'Acetaminophen': 'B',   // Generally considered safe (preferred analgesic)
  'Omeprazole': 'C',      // Use with caution
};

// ============================================================================
// Helper: Normalize drug pair key for interaction lookup
// ============================================================================
export function getInteractionKey(drugA: string, drugB: string): string {
  return [drugA, drugB].sort().join('|');
}

// ============================================================================
// Local Drug Class Table (fallback when RxNorm is unavailable)
// Maps drug names to their therapeutic classes
// ============================================================================
export const LOCAL_DRUG_CLASSES: Record<string, string[]> = {
  'Warfarin': ['Anticoagulants', 'Antithrombotics'],
  'Aspirin': ['Antithrombotics', 'NSAIDs', 'Analgesics'],
  'Heparin': ['Anticoagulants', 'Antithrombotics'],
  'Rivaroxaban': ['Anticoagulants', 'Antithrombotics'],
  'Apixaban': ['Anticoagulants', 'Antithrombotics'],
  'Ibuprofen': ['NSAIDs', 'Analgesics', 'Anti-inflammatory'],
  'Naproxen': ['NSAIDs', 'Analgesics', 'Anti-inflammatory'],
  'Acetaminophen': ['Analgesics', 'Antipyretics'],
  'Lisinopril': ['ACE Inhibitors', 'Antihypertensives'],
  'Enalapril': ['ACE Inhibitors', 'Antihypertensives'],
  'Metoprolol': ['Beta-Blockers', 'Antihypertensives'],
  'Atenolol': ['Beta-Blockers', 'Antihypertensives'],
  'Propranolol': ['Beta-Blockers', 'Antihypertensives'],
  'Metformin': ['Biguanides', 'Antidiabetics'],
  'Sumatriptan': ['Triptans', 'Antimigraine'],
  'Amoxicillin': ['Penicillins', 'Antibiotics'],
  'Omeprazole': ['Proton Pump Inhibitors', 'Antacids'],
};

// ============================================================================
// Alternative Drug Suggestions (fallback when RxNorm is unavailable)
// Maps a flagged drug to safer alternatives to consider
// ============================================================================
export const ALTERNATIVE_DRUGS: Record<string, string[]> = {
  'Ibuprofen': ['Acetaminophen', 'Naproxen', 'Celecoxib'],
  'Naproxen': ['Acetaminophen', 'Ibuprofen', 'Celecoxib'],
  'Aspirin': ['Acetaminophen', 'Clopidogrel'],
  'Warfarin': ['Rivaroxaban', 'Apixaban', 'Dabigatran'],
  'Lisinopril': ['Losartan', 'Amlodipine', 'Hydrochlorothiazide'],
  'Amoxicillin': ['Azithromycin', 'Doxycycline', 'Ciprofloxacin'],
  'Sumatriptan': ['Rizatriptan', 'Acetaminophen', 'Naproxen'],
  'Metformin': ['Glipizide', 'Sitagliptin', 'Pioglitazone'],
  'Metoprolol': ['Amlodipine', 'Lisinopril', 'Losartan'],
};
