/**
 * 🌿 AYUSH Agent (India-Localized)
 * Responsible for checking dangerous interactions between Allopathic
 * (Western) drugs and Ayurvedic/herbal remedies — a gap that standard
 * Western APIs like OpenFDA and RxNorm do NOT cover.
 * 
 * "Standard APIs only protect patients in the West. We localized our
 * MCP agent to protect Indian patients who frequently mix Allopathic
 * and Ayurvedic treatments."
 * 
 * Tools: check_ayush_interaction
 */
import { ToolDecorator as Tool, ExecutionContext, z } from '@nitrostack/core';
import {
  findAllAyushInteractionsForDrug,
  findAllAyushInteractionsForHerb,
} from '../data/clinical-tables.js';

export class AyushAgent {

  // ==========================================================================
  // check_ayush_interaction (AYUSH / Ayurvedic × Allopathic)
  // ==========================================================================
  @Tool({
    name: 'check_ayush_interaction',
    description: 'Checks for dangerous interactions between the proposed Allopathic (Western) drug and any Ayurvedic/herbal remedies the patient is currently taking. This covers interactions that standard APIs like OpenFDA do NOT track — critical for Indian patients who frequently combine Allopathic and Ayurvedic treatments.',
    inputSchema: z.object({
      newDrug: z.string().describe('The newly prescribed Allopathic drug name'),
      herbalRemedies: z.array(z.string()).describe('Patient\'s current Ayurvedic/herbal remedies (e.g., ["Ashwagandha", "Triphala", "Guggul"])'),
      currentMedications: z.array(z.string()).optional().describe('Patient\'s current Allopathic medications (optional, for comprehensive herb-drug check)'),
    }),
    examples: {
      request: { newDrug: 'Diazepam', herbalRemedies: ['Ashwagandha', 'Triphala'] },
      response: {
        hasInteraction: true,
        interactions: [{
          herb: 'Ashwagandha',
          drug: 'Diazepam',
          severity: 'major',
          effect: 'Excessive sedation, respiratory depression',
          citation: 'Indian Journal of Pharmacology, 2019',
        }],
      },
    },
  })
  async checkAyushInteraction(
    input: { newDrug: string; herbalRemedies: string[]; currentMedications?: string[] },
    ctx: ExecutionContext
  ) {
    ctx.logger.info('🌿 AYUSH Agent: Checking herb-drug interactions', {
      newDrug: input.newDrug,
      herbs: input.herbalRemedies,
    });

    if (!input.herbalRemedies || input.herbalRemedies.length === 0) {
      return {
        hasInteraction: false,
        interactions: [],
        note: 'No herbal remedies reported by patient.',
        citation: 'N/A — No AYUSH remedies to cross-reference',
      };
    }

    // Check each herb against the new drug
    const foundInteractions = findAllAyushInteractionsForDrug(input.newDrug, input.herbalRemedies);

    // Also check each herb against existing allopathic medications
    const existingMedInteractions: any[] = [];
    if (input.currentMedications && input.currentMedications.length > 0) {
      for (const herb of input.herbalRemedies) {
        const herbInteractions = findAllAyushInteractionsForHerb(herb, input.currentMedications);
        existingMedInteractions.push(...herbInteractions);
      }
    }

    const allInteractions = [...foundInteractions, ...existingMedInteractions];

    // Deduplicate by herb+drug pair
    const seen = new Set<string>();
    const uniqueInteractions = allInteractions.filter(i => {
      const key = `${i.herb}|${i.drug}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      hasInteraction: uniqueInteractions.length > 0,
      interactions: uniqueInteractions.map(i => ({
        herb: i.herb,
        drug: i.drug,
        severity: i.severity,
        effect: i.effect,
        mechanism: i.mechanism,
        recommendation: i.recommendation,
        citation: i.citation,
      })),
      herbsChecked: input.herbalRemedies,
      drugsChecked: [input.newDrug, ...(input.currentMedications || [])],
      note: uniqueInteractions.length > 0
        ? `⚠️ ${uniqueInteractions.length} AYUSH herb-drug interaction(s) found. These are NOT covered by standard Western drug databases like OpenFDA.`
        : '✅ No known AYUSH herb-drug interactions found.',
      citation: uniqueInteractions.length > 0
        ? uniqueInteractions.map(i => `${i.herb} × ${i.drug}: ${i.citation}`).join('; ')
        : 'Cross-referenced against PharmaGuard AYUSH Interaction Database (AYUSH Ministry Guidelines, Indian pharmacological journals)',
    };
  }
}
