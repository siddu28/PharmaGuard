import { Module } from '@nitrostack/core';
import { PharmaGuardTools } from './pharma-guard.tools.js';
import { PharmaGuardResources } from './pharma-guard.resources.js';
import { PharmaGuardPrompts } from './pharma-guard.prompts.js';

@Module({
  name: 'pharma-guard',
  description: 'AI Medication Safety Copilot — multi-factor clinical risk analysis',
  controllers: [PharmaGuardTools, PharmaGuardResources, PharmaGuardPrompts]
})
export class PharmaGuardModule {}
